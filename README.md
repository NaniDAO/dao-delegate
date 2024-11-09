# NANIDAO Delegate

**WIP**

A Cloud Function that processes and signs DAO proposals using AI-powered decision making.

## Features
- Automatically evaluates proposals using NANI AI
- Signs approved proposals using GCP KMS
- Stores results in PostgreSQL database
- Supports multiple EVM chains (Ethereum, Arbitrum, Base)

## Setup
1. Set environment variables:
```bash
CREDENTIALS=<GCP credentials>
DATABASE_URL=<PostgreSQL connection string>
NANI_AI_KEY=<NANI API key>
```

2. Deploy to Google Cloud Functions:
```bash
gcloud functions deploy vote
```

## Usage
The function runs automatically and:
- Fetches recent proposals
- Evaluates them using NANI AI
- Signs approved proposals
- Stores results in database

## Requirements
- Node.js
- PostgreSQL
- Google Cloud Platform account
- NANI AI API access

## License
MIT
