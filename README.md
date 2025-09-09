# Strady Market Data API 📈

A simple and efficient Node.js API built with Express for uploading, caching, and searching stock and currency rate data.

## Features

* **File-Based Data Ingestion**: Upload stock data (`euronext.csv`, `us.csv`) and currency rates (`eurofxref.csv`).

* **Intelligent Caching**: In-memory cache is populated on startup and updated via API endpoints. Stock data sources are cached independently.

* **Dynamic Validation**: Robust validation for filenames and required CSV headers to prevent incorrect data uploads.

* **Unified Search**: A powerful search endpoint to query across all stock data sources with wildcard (`%`) support.

* **Dynamic Configuration**: Server host and port are configured via a `.env` file.

* **Interactive Documentation**: API is fully documented with Swagger UI, with the server URL updated dynamically.

* **Automatic Cache Initialization**: The server pre-loads all files from the `/data` directory on startup.

## API Documentation

Full, interactive API documentation is available via Swagger UI. Once the server is running, you can access it at:

`http://{HOST}:{PORT}/api-docs`

(Replace `{HOST}` and `{PORT}` with the values from your `.env` file).

## Prerequisites

* Node.js (v14 or later recommended)

* npm

## Setup & Installation

Follow these steps to get the project running on your local machine.

**1. Clone the repository:**

```
git clone <your-repository-url>
cd <repository-directory>

```

**2. Install dependencies:**

```
npm install

```

**3. Create the environment configuration file:**

Create a file named `.env` in the root of the project and add the following variables.

```
# .env
HOST=localhost
PORT=8080

```

**4. (Optional) Pre-load the cache:**

Place your `euronext.csv`, `us.csv`, or `eurofxref.csv` files into a `data/` directory in the project root. The server will load them on startup.

**5. Start the server:**

```
node server.js

```

You should see a confirmation that the server is running on the configured host and port.

## API Endpoints

Here is a summary of the available endpoints. For detailed information on request bodies and responses, please refer to the Swagger Documentation.

| Method | Endpoint | Description |
| ----- | ----- | ----- |
| POST | `/upload/stocks` | Upload `euronext.csv` or `us.csv` to update the stock data cache. |
| POST | `/upload/rates` | Upload `eurofxref.csv` to update the currency rates cache. |
| GET | `/search` | Search all stocks by Name, Symbol, or ISIN. |
| GET | `/search/rates/{pattern}` | Get a currency rate (e.g., `/search/rates/EUR_USD`). |
