import { http } from "@google-cloud/functions-framework";
import pg from "pg";
import { toGcpAccount } from "@nanidao/gcp-account";
import { mainnet, base, arbitrum } from "viem/chains";
import { createPublicClient, http as viemHttp, concat, pad, toHex } from "viem";
import { getKeyFromNonce, getValidatorKey } from "eip-7582-utils";

// Environment configuration
const types = {
  ValidateUserOp: [
    { name: "sender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "initCode", type: "bytes" },
    { name: "callData", type: "bytes" },
    { name: "accountGasLimits", type: "bytes32" },
    { name: "preVerificationGas", type: "uint256" },
    { name: "gasFees", type: "bytes32" },
    { name: "paymasterAndData", type: "bytes" },
    { name: "validUntil", type: "uint48" },
    { name: "validAfter", type: "uint48" },
  ],
};

const credentials = process.env.CREDENTIALS.trim();
const CONNECTION_STRING = process.env.DATABASE_URL;

if (!credentials) throw new Error("Missing KMS credentials");
if (!CONNECTION_STRING) throw new Error("Missing DB credentials");

// Database initialization
const pool = new pg.Pool({
  connectionString: CONNECTION_STRING,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Basic health check endpoint
http("vote", async (req, res) => {
  try {
    const proposals = await getRecentProposals();
    console.log(`Found ${proposals.length} proposals to process`);

    const account = await toGcpAccount({ credentials });
    console.log("ACCOUNT:", account.address);

    const results = [];

    // Process each proposal
    for (const proposal of proposals) {
      try {
        console.log(`Processing proposal with hash: ${proposal.userOpHash}`);

        const { vote, reason } = await getNaniVote(proposal);
        console.log(`Vote for ${proposal.userOpHash}:`, vote);

        if (Boolean(vote) === true) {
          const signature = await signProposal(account, proposal);
          console.log(`Signature for ${proposal.userOpHash}:`, signature);

          await addSignature({
            signer: account.address,
            account: proposal.sender,
            hash: proposal.userOpHash,
            signature: signature,
            reason: reason,
          });

          results.push({
            hash: proposal.userOpHash,
            status: "success",
            signature,
            vote,
            reason,
          });
        } else {
          await addSignature({
            signer: account.address,
            account: proposal.sender,
            hash: proposal.userOpHash,
            signature: "",
            reason: reason,
          });

          results.push({
            hash: proposal.userOpHash,
            status: "rejected",
            vote,
            reason,
          });
        }
      } catch (error) {
        console.error(
          `Error processing proposal ${proposal.userOpHash}:`,
          error,
        );
        results.push({
          hash: proposal.userOpHash,
          status: "error",
          error: error.message,
        });
      }
    }

    res.status(200).json({
      message: `Processed ${proposals.length} proposals`,
      results,
    });
  } catch (error) {
    console.error("Error in main function:", error);
    res.status(500).json({
      error: "Internal Server Error",
      details: error.message,
    });
  }
});

const TARGET_SENDER = "0x0000000000001d8a2e7bf6bc369525a2654aa298";
const AI_SIGNER = "0x466d3E0E6D661d6E7626e9dea93c460BD4e15B40";

const getRecentProposals = async (retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      const query = `
        SELECT *
        FROM proposals
        WHERE created_at >= NOW() - INTERVAL '24 hour'
        AND sender = $1
        AND "userOpHash" NOT IN (
          SELECT hash
          FROM signatures
          WHERE signer = $2
        )
        ORDER BY created_at ASC
      `;

      const values = [TARGET_SENDER.toLowerCase(), AI_SIGNER.toLowerCase()];

      const result = await pool.query(query, values);
      console.log(
        `Found ${result.rows.length} proposals for sender ${TARGET_SENDER}`,
      );
      return result.rows;
    } catch (error) {
      console.error(`Attempt ${i + 1} failed:`, error);
      if (i === retries - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1))); // Exponential backoff
    }
  }
};

const addSignature = async (sig) => {
  const query = `
    INSERT INTO signatures (signer, account, hash, signature, content)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `;
  const values = [
    sig.signer.toLowerCase(),
    sig.account ? sig.account.toLowerCase() : null,
    sig.hash.toLowerCase(),
    sig.signature,
    sig.reason,
  ];

  try {
    const result = await pool.query(query, values);
    return result.rows[0];
  } catch (error) {
    console.error("Error in addSignature:", error);
    throw error;
  }
};

const getNaniVote = async (proposal) => {
  const makeRequest = async (additionalInstruction = "") => {
    const response = await fetch("http://nani.ooo/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.NANI_AI_KEY,
      },
      body: JSON.stringify({
        messages: [
          {
            role: "system",
            content: `You are NANI, an AI member of the DAO. You must carefully evaluate whether the following proposal is in the best interest of the DAO. Analyze the proposal and determine if it should be approved. Your response must be in JSON format with 'vote' being true or false and include a 'reason' explaining your decision. Format: {"vote":true/false,"reason":"explanation"}. ${additionalInstruction} Here is the proposal to evaluate: ${proposal.content}`,
          },
        ],
      }),
    });

    const text = await response.text();
    try {
      console.log("RESPONSE", text);
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  };

  // First attempt
  let result = await makeRequest();
  if (result) return result;

  // Second attempt with stronger instruction
  result = await makeRequest(
    "You must respond with ONLY valid JSON, no other text or explanation.",
  );
  if (result) return result;

  // Final attempt with very explicit instruction
  result = await makeRequest(
    'CRITICAL: Respond with ONLY a JSON object in the exact format {"vote": boolean, "reason": "string"} - no other text whatsoever.',
  );
  if (result) return result;

  throw new Error("Failed to get valid JSON response after 3 attempts");
};

const signProposal = async (account, proposal) => {
  let userOperation = {
    sender: proposal.sender,
    nonce: BigInt(proposal.nonce),
    callData: proposal.callData,
    verificationGasLimit: BigInt(proposal.verificationGasLimit),
    callGasLimit: BigInt(proposal.callGasLimit),
    preVerificationGas: BigInt(proposal.preVerificationGas),
    maxFeePerGas: BigInt(proposal.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(proposal.maxPriorityFeePerGas),
    signature: "0x",
    factory: proposal?.factory,
    factoryData: proposal?.factoryData,
    paymaster: proposal?.paymaster,
    paymasterPostOpGasLimit: proposal?.paymasterPostOpGasLimit
      ? BigInt(proposal.paymasterPostOpGasLimit)
      : undefined,
    paymasterVerificationGasLimit: proposal?.paymasterVerificationGasLimit
      ? BigInt(proposal.paymasterVerificationGasLimit)
      : undefined,
    paymasterData: proposal?.paymasterData,
  };

  let domain = await getDomain(userOperation.sender, proposal.chain);
  const gasFees = packGasLimits(userOperation);
  const accountGasLimits = packAccountGasLimits(userOperation);
  const paymasterAndData = packPaymasterAndData(userOperation);
  const initCode = packInitCode(userOperation);

  const message = {
    sender: userOperation.sender,
    nonce: userOperation.nonce,
    initCode: initCode,
    callData: userOperation.callData,
    accountGasLimits,
    preVerificationGas: userOperation.preVerificationGas,
    gasFees,
    paymasterAndData,
    validUntil: BigInt(0),
    validAfter: BigInt(0),
  };

  const key = getKeyFromNonce(userOperation.nonce);
  if (
    key !== "0x0000000000000000000000000000000000000000000000000000000000000000"
  ) {
    if (key === getValidatorKey(getValidator("remote-validator").address)) {
      domain = {
        name: "RemoteValidator",
        version: "1.0.0",
        chainId: publicClient.chain.id,
        verifyingContract: getValidator("remote-validator").address,
      };
    }
  }

  console.log("Signing user operation", message);

  const signature = await account.signTypedData({
    domain,
    types,
    primaryType: "ValidateUserOp",
    message,
  });

  return signature;
};

const validatorApps = [
  {
    id: "remote-validator",
    address: "0x0000000000159aAFCA7067005E28665a28B5B4cf",
    title: "Scheduler",
    icon: "/apps/remote-validator.png",
    description:
      "Set specific days and times for your transactions to be processed",
  },
  {
    id: "recovery-validator",
    address: "0x000000000000a78fb292191473e51dd34700c43d",
    title: "Recovery",
    icon: "/apps/recovery-validator.png",
    description:
      "Set backup roles to recover your account in case of an emergency",
  },
  {
    id: "joint-validator",
    address: "0x000000000000D3D2b2980A7BC509018E4d88e947",
    title: "Joint Ownership",
    icon: "/apps/joint-validator.webp",
    description:
      "Add joint owners to your smart account with full concurrent rights",
  },
  {
    id: "payment-validator",
    address: "0x00000000000032CD4FAE890F90e61e6864e44aa7",
    title: "Payment Plans",
    icon: "/apps/payment-validator.webp",
    description: "Add payment plans and delegate token transfer permissions",
  },
  {
    id: "permit-validator",
    address: "0x000000000000ab6c9FF3ed50AC4BAF2a20890835",
    title: "Custom Permissions",
    icon: "/apps/permit-validator.webp",
    description: "Add arbitrary permissions within the Permit structure",
  },
];

const getValidator = (id) => {
  const app = validatorApps.find((app) => app.id === id);
  if (!app) {
    throw new Error("App not found");
  }
  return app;
};

function packInitCode(unpackedUserOperation) {
  return unpackedUserOperation.factory
    ? concat([
        unpackedUserOperation.factory,
        unpackedUserOperation.factoryData || "0x",
      ])
    : "0x";
}

function packAccountGasLimits(unpackedUserOperation) {
  return concat([
    pad(toHex(unpackedUserOperation.verificationGasLimit), { size: 16 }),
    pad(toHex(unpackedUserOperation.callGasLimit), { size: 16 }),
  ]);
}

function packGasLimits(unpackedUserOperation) {
  return concat([
    pad(toHex(unpackedUserOperation.maxPriorityFeePerGas), { size: 16 }),
    pad(toHex(unpackedUserOperation.maxFeePerGas), { size: 16 }),
  ]);
}

function packPaymasterAndData(unpackedUserOperation) {
  return unpackedUserOperation.paymaster
    ? concat([
        unpackedUserOperation.paymaster,
        pad(toHex(unpackedUserOperation.paymasterVerificationGasLimit || 0), {
          size: 16,
        }),
        pad(toHex(unpackedUserOperation.paymasterPostOpGasLimit || 0), {
          size: 16,
        }),
        unpackedUserOperation.paymasterData || "0x",
      ])
    : "0x";
}

const eip712DomainABI = [
  {
    inputs: [],
    name: "eip712Domain",
    outputs: [
      { internalType: "bytes1", name: "fields", type: "bytes1" },
      { internalType: "string", name: "name", type: "string" },
      { internalType: "string", name: "version", type: "string" },
      { internalType: "uint256", name: "chainId", type: "uint256" },
      { internalType: "address", name: "verifyingContract", type: "address" },
      { internalType: "bytes32", name: "salt", type: "bytes32" },
      { internalType: "uint256[]", name: "extensions", type: "uint256[]" },
    ],
    stateMutability: "view",
    type: "function",
  },
];

const getDomain = async (sender, chain) => {
  const publicClient = createPublicClient({
    chain: resolveChain(chain),
    transport: viemHttp(),
  });

  const data = await publicClient.readContract({
    address: sender,
    abi: eip712DomainABI,
    functionName: "eip712Domain",
  });

  return {
    name: data[1],
    version: data[2],
    chainId: Number(data[3]),
    verifyingContract: data[4],
  };
};

const resolveChain = (chain) => {
  switch (chain.toLowerCase()) {
    case "eth":
      return mainnet;
    case "arbitrum":
      return arbitrum;
    case "base":
      return base;
    default:
      throw new Error("Unsupported chain ", chain);
  }
};
