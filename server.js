require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const swaggerUi = require('swagger-ui-express');
const yaml = require('js-yaml');
const axios = require('axios');
const admZip = require('adm-zip');
const cron = require('node-cron');

const app = express();
<<<<<<< HEAD
=======
// Use environment variables with fallbacks
>>>>>>> de1ff57ed3ec8e980e779d5f5fad8d808e58bf54
const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 3000;

// --- In-Memory Storage ---
let stockData = {};
let ratesData = {};

// --- Swagger Configuration ---
const swaggerDocument = yaml.load(fs.readFileSync('./swagger.yaml', 'utf8'));
swaggerDocument.servers = [{ url: `http://${HOST}:${PORT}` }];
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// --- API Key Authentication Middleware ---
const apiKeyAuth = (req, res, next) => {
    const apiKey = req.header('X-API-Key');
    // Get keys from .env, split by comma, and trim whitespace
    const validApiKeys = (process.env.VALID_API_KEYS || '').split(',').map(key => key.trim());

    if (!apiKey) {
        return res.status(401).send({ message: 'Unauthorized: API Key is missing. Please include it in the "X-API-Key" header.' });
    }

    if (!validApiKeys.includes(apiKey)) {
        return res.status(403).send({ message: 'Forbidden: Invalid API Key.' });
    }

    // If the key is valid, proceed to the next middleware or route handler
    next();
};

// Apply the middleware to all routes defined after this line
app.use(apiKeyAuth);


// --- PROTECTED API Endpoints ---

// --- Data Processing, Multer, and other functions (no changes here) ---
// (processStockFile, processRatesFile, storage configs, etc. remain the same)
const processStockFile = (fileName, filePath) => {
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    let newStockData = [];
    if (fileName === 'euronext.csv') {
        const lines = fileContent.split('\n').filter(line => line.includes(';'));
        if (lines.length === 0) throw new Error('Invalid or empty euronext.csv file.');
        lines.forEach(line => {
            const columns = line.split(';');
            if (columns.length > 3 && columns[0] && columns[1] && columns[2]) {
                const [Name, ISIN, Symbol, Market, Currency, OpenPrice, HighPrice, lowPrice, lastPrice] = columns;
                newStockData.push({ Name: Name.replace(/"/g, ''), ISIN: ISIN.replace(/"/g, ''), Symbol: Symbol.replace(/"/g, ''), Currency: Currency ? Currency.replace(/"/g, '') : 'N/A', 'last price': lastPrice ? lastPrice.replace(/"/g, '').trim() : '0', 'upload_date': new Date().toISOString(), 'datasource_name': 'euronext.csv' });
            }
        });
    } else if (fileName === 'us.csv') {
        const lines = fileContent.split('\n').filter(line => line.includes(','));
        if (lines.length === 0) throw new Error('Invalid or empty us.csv file.');
        lines.filter(l => !l.startsWith('Symbol,Name,')).forEach(line => {
            const [Symbol, Name, LastSale] = line.split(',');
            if (Symbol && Name && LastSale) {
                newStockData.push({ Name: Name, ISIN: "", Symbol: Symbol, Currency: "USD", 'last price': LastSale.replace(/\$/g, ''), 'upload_date': new Date().toISOString(), 'datasource_name': 'us.csv' });
            }
        });
    } else { throw new Error(`Unsupported stock file: ${fileName}`); }
    return newStockData;
};
const processRatesFile = (filePath) => {
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const lines = fileContent.split('\n').filter(line => line.includes(','));
    if (lines.length < 2) throw new Error('Invalid rates file: requires header and data lines.');
    const headers = lines[0].split(',').map(h => h.trim());
    const values = lines[1].split(',').map(v => v.trim());
    const newRates = {};
    headers.forEach((header, index) => { if (header && header !== 'Date' && values[index]) newRates[header] = parseFloat(values[index]) });
    return { rates: newRates, upload_date: new Date().toISOString(), datasource_name: 'eurofxref.csv' };
};
// ... other functions ...


// --- Data Refresh Logic ---
const refreshEuronextData = async () => {
    const url = process.env.EURONEXT_DATA_URL;
    if (!url) { console.error('EURONEXT_DATA_URL not set in .env file.'); return; }
    console.log('Refreshing Euronext data...');
    try {
        const finalFilePath = path.join(__dirname, 'data', 'euronext.csv');
        fs.mkdirSync(path.dirname(finalFilePath), { recursive: true });
        const response = await axios({ method: 'get', url, responseType: 'arraybuffer' });
        const contentType = response.headers['content-type'];
        if (contentType && (contentType.includes('application/zip') || contentType.includes('application/x-zip-compressed'))) {
            const zip = new admZip(response.data);
            const csvEntry = zip.getEntries().find(entry => entry.entryName.toLowerCase().endsWith('.csv'));
            if (!csvEntry) throw new Error('No CSV file found in the Euronext ZIP archive.');
            fs.writeFileSync(finalFilePath, zip.readAsText(csvEntry));
        } else {
            fs.writeFileSync(finalFilePath, response.data);
        }
        const newStockData = processStockFile('euronext.csv', finalFilePath);
        stockData['euronext.csv'] = newStockData;
        console.log(`✅ Euronext cache updated with ${newStockData.length} records.`);
        return { success: true, records_loaded: newStockData.length };
    } catch (error) {
        console.error('❌ Failed to refresh Euronext data:', error.message);
        throw error;
    }
};

const refreshRatesData = async () => {
    const url = process.env.EURFX_RATES_URL;
    if (!url) { console.error('EURFX_RATES_URL not set in .env file.'); return; }
    console.log('Refreshing currency rates data...');
    try {
        const finalFilePath = path.join(__dirname, 'data', 'eurofxref.csv');
        fs.mkdirSync(path.dirname(finalFilePath), { recursive: true });
        const response = await axios({ method: 'get', url, responseType: 'arraybuffer' });
        const zip = new admZip(response.data);
        const csvEntry = zip.getEntries().find(entry => entry.entryName.toLowerCase().endsWith('.csv'));
        if (!csvEntry) throw new Error('No CSV file found in the ECB ZIP archive.');
        fs.writeFileSync(finalFilePath, zip.readAsText(csvEntry));
        ratesData = processRatesFile(finalFilePath);
        console.log(`✅ Currency rates cache updated with ${Object.keys(ratesData.rates).length} currencies.`);
        return { success: true, currencies_loaded: Object.keys(ratesData.rates).length };
    } catch (error) {
        console.error('❌ Failed to refresh currency rates data:', error.message);
        throw error;
    }
};

// --- API Endpoints ---
// (Your existing /upload/stocks, /upload/rates, /search, etc. endpoints)
// ...

app.post('/refresh/euronext', async (req, res) => {
    try {
        const result = await refreshEuronextData();
        res.status(200).send({ message: 'Successfully refreshed Euronext stock data.', ...result });
    } catch (error) {
        res.status(500).send({ message: 'Failed to refresh Euronext data.', error: error.message });
    }
});

app.post('/refresh/rates', async (req, res) => {
    try {
        const result = await refreshRatesData();
        res.status(200).send({ message: 'Successfully refreshed currency rates data.', ...result });
    } catch (error) {
        res.status(500).send({ message: 'Failed to refresh currency rates data.', error: error.message });
    }
});

// --- Server Startup Logic ---
const initializeCache = () => {
    // ... (no changes to this function)
};

initializeCache();

// --- Scheduled Jobs ---
// Runs at 2:00 AM every day
cron.schedule('0 2 * * *', refreshEuronextData, { timezone: "Europe/Brussels" });
// Runs at 3:00 AM every day
cron.schedule('0 3 * * *', refreshRatesData, { timezone: "Europe/Brussels" });

// --- Start Server ---
app.listen(PORT, HOST, () => {
    console.log(`Server is running on http://${HOST}:${PORT}`);
    console.log(`API documentation available at http://${HOST}:${PORT}/api-docs`);
    console.log('Scheduled jobs for data refresh are active.');
});