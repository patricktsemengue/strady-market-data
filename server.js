// --- 1. Load Dependencies ---
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
const logger = require('./logger'); // Import the custom logger

// --- 2. Initialize Express App and Configuration ---
const app = express();
const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 3000;

// --- 3. In-Memory Storage ---
let stockData = {};
let ratesData = {};

// --- 4. Swagger UI Configuration ---
const swaggerDocument = yaml.load(fs.readFileSync('./swagger.yaml', 'utf8'));
swaggerDocument.servers = [{ url: `http://${HOST}:${PORT}` }];
// The Swagger UI route is public and must be defined before authentication
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// --- 5. API Key Authentication Middleware ---
const apiKeyAuth = (req, res, next) => {
    logger.debug(`Request received for: ${req.method} ${req.originalUrl}`);
    const apiKey = req.header('X-API-Key');
    const validApiKeys = (process.env.VALID_API_KEYS || '').split(',').map(key => key.trim());

    if (!apiKey) {
        logger.warn(`Unauthorized access attempt: API Key missing from ${req.ip}`);
        return res.status(401).send({ message: 'Unauthorized: API Key is missing. Please include it in the "X-API-Key" header.' });
    }
    if (!validApiKeys.includes(apiKey)) {
        logger.warn(`Forbidden access attempt: Invalid API Key used from ${req.ip}`);
        return res.status(403).send({ message: 'Forbidden: Invalid API Key.' });
    }
    logger.debug('API Key authentication successful.');
    next();
};

// Apply the middleware to all routes defined after this line
app.use(apiKeyAuth);

// --- 6. Data Processing Functions ---
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

// --- 7. Data Refresh Functions (Download & Process) ---
const refreshEuronextData = async () => {
    const url = process.env.EURONEXT_DATA_URL;
    if (!url) {
        logger.warn('EURONEXT_DATA_URL not set in .env file. Skipping refresh.');
        return;
    }
    logger.info('Refreshing Euronext data...');
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
        logger.info(`✅ Euronext cache updated with ${newStockData.length} records.`);
        return { success: true, records_loaded: newStockData.length };
    } catch (error) {
        logger.error(`Failed to refresh Euronext data: ${error.message}`);
        throw error;
    }
};

const refreshRatesData = async () => {
    const url = process.env.EURFX_RATES_URL;
    if (!url) {
        logger.warn('EURFX_RATES_URL not set in .env file. Skipping refresh.');
        return;
    }
    logger.info('Refreshing currency rates data...');
    try {
        const finalFilePath = path.join(__dirname, 'data', 'eurofxref.csv');
        fs.mkdirSync(path.dirname(finalFilePath), { recursive: true });
        const response = await axios({ method: 'get', url, responseType: 'arraybuffer' });
        const zip = new admZip(response.data);
        const csvEntry = zip.getEntries().find(entry => entry.entryName.toLowerCase().endsWith('.csv'));
        if (!csvEntry) throw new Error('No CSV file found in the ECB ZIP archive.');
        fs.writeFileSync(finalFilePath, zip.readAsText(csvEntry));
        ratesData = processRatesFile(finalFilePath);
        logger.info(`✅ Currency rates cache updated with ${Object.keys(ratesData.rates).length} currencies.`);
        return { success: true, currencies_loaded: Object.keys(ratesData.rates).length };
    } catch (error) {
        logger.error(`Failed to refresh currency rates data: ${error.message}`);
        throw error;
    }
};

// --- 8. File Upload Configuration (Multer) ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadPath = 'data/';
        fs.mkdirSync(uploadPath, { recursive: true });
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => { cb(null, file.originalname); }
});
const upload = multer({ storage: storage });

// --- 9. API Endpoints ---
app.post('/upload/stocks', upload.single('stockFile'), (req, res) => {
    if (!req.file) return res.status(400).send({ message: 'No file uploaded.' });
    logger.info(`Processing stock file upload: ${req.file.originalname}`);
    try {
        const { originalname, path: filePath } = req.file;
        const newStockData = processStockFile(originalname, filePath);
        stockData[originalname] = newStockData;
        res.status(200).send({ message: `${originalname} processed successfully.`, records_loaded: newStockData.length });
    } catch (error) {
        logger.error(`Error processing stock upload ${req.file.originalname}: ${error.message}`);
        res.status(400).send({ message: error.message });
    }
});

app.post('/upload/rates', upload.single('ratesFile'), (req, res) => {
    if (!req.file) return res.status(400).send({ message: 'No file uploaded.' });
    logger.info(`Processing rates file upload: ${req.file.originalname}`);
    try {
        ratesData = processRatesFile(req.file.path);
        res.status(200).send({ message: 'Rates file processed successfully.', currencies_loaded: Object.keys(ratesData.rates).length });
    } catch (error) {
        logger.error(`Error processing rates upload ${req.file.originalname}: ${error.message}`);
        res.status(400).send({ message: error.message });
    }
});

app.get('/search', (req, res) => {
    const { query } = req.query;
    logger.debug(`Stock search requested with query: "${query}"`);
    const allStocks = Object.values(stockData).flat();
    if (!query) return res.status(200).json(allStocks);
    const searchQuery = query.replace(/%/g, '.*');
    const searchRegex = new RegExp(searchQuery, 'i');
    const results = allStocks.filter(stock => searchRegex.test(stock.Name) || searchRegex.test(stock.Symbol) || (stock.ISIN && searchRegex.test(stock.ISIN)));
    res.status(200).json(results);
});

app.get('/search/rates/:pattern', (req, res) => {
    const { pattern } = req.params;
    logger.debug(`Rates search requested for pattern: "${pattern}"`);
    const match = pattern.match(/^EUR_(\w{3})$/);
    if (!match) return res.status(400).send({ message: "Invalid pattern. Use format EUR_{CURRENCY}." });
    const currency = match[1];
    if (!ratesData.rates || !ratesData.rates[currency]) return res.status(404).send({ message: `Currency '${currency}' not found.` });
    res.status(200).json({ pair: pattern, value: ratesData.rates[currency], upload_date: ratesData.upload_date, datasource_name: ratesData.datasource_name });
});

app.post('/refresh/euronext', async (req, res) => {
    logger.info('On-demand Euronext refresh triggered via API.');
    try {
        const result = await refreshEuronextData();
        res.status(200).send({ message: 'Successfully refreshed Euronext stock data.', ...result });
    } catch (error) {
        res.status(500).send({ message: 'Failed to refresh Euronext data.', error: error.message });
    }
});

app.post('/refresh/rates', async (req, res) => {
    logger.info('On-demand currency rates refresh triggered via API.');
    try {
        const result = await refreshRatesData();
        res.status(200).send({ message: 'Successfully refreshed currency rates data.', ...result });
    } catch (error) {
        res.status(500).send({ message: 'Failed to refresh currency rates data.', error: error.message });
    }
});

// --- 10. Server Startup Logic ---
const initializeCache = () => {
    logger.info('Attempting to initialize cache from /data directory...');
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) {
        logger.warn('Data directory not found. Server will start with an empty cache.');
        return;
    }
    const files = fs.readdirSync(dataDir);
    files.forEach(fileName => {
        const filePath = path.join(dataDir, fileName);
        try {
            if (fileName === 'euronext.csv' || fileName === 'us.csv') {
                const newStockData = processStockFile(fileName, filePath);
                stockData[fileName] = newStockData;
                logger.info(`✅ Successfully loaded ${newStockData.length} records from ${fileName}.`);
            } else if (fileName === 'eurofxref.csv') {
                ratesData = processRatesFile(filePath);
                logger.info(`✅ Successfully loaded ${Object.keys(ratesData.rates).length} currencies from ${fileName}.`);
            }
        } catch (error) {
            logger.error(`❌ Failed to load or process ${fileName}: ${error.message}`);
        }
    });
};

initializeCache();

// --- 11. Scheduled Jobs (Cron) ---
logger.info('Setting up scheduled jobs...');
cron.schedule('0 2 * * *', () => {
    logger.info('Running scheduled job: Refreshing Euronext Data.');
    refreshEuronextData();
}, { timezone: "Europe/Brussels" });

cron.schedule('0 3 * * *', () => {
    logger.info('Running scheduled job: Refreshing Currency Rates Data.');
    refreshRatesData();
}, { timezone: "Europe/Brussels" });

// --- 12. Start Server ---
app.listen(PORT, HOST, () => {
    logger.info(`Server is running on http://${HOST}:${PORT}`);
    logger.info(`API documentation available at http://${HOST}:${PORT}/api-docs`);
    logger.info('Scheduled jobs for daily data refresh are active.');
});