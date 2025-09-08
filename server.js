require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const swaggerUi = require('swagger-ui-express');
const yaml = require('js-yaml');

const app = express();
// Use environment variables with fallbacks
const HOST = process.env.HOST || 'localhost';
const PORT = process.env.PORT || 3000;

// --- In-Memory Storage ---
let stockData = {};
let ratesData = {};

// --- Swagger Configuration ---
const swaggerDocument = yaml.load(fs.readFileSync('./swagger.yaml', 'utf8'));
// Dynamically set the server URL in Swagger based on environment variables
swaggerDocument.servers = [{ url: `http://${HOST}:${PORT}` }];
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));


// --- REFACTORED: Data Processing Logic (remains the same) ---
const processStockFile = (fileName, filePath) => {
    // ... (logic from previous step, no changes needed)
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    let newStockData = [];
    if (fileName === 'euronext.csv') {
        const lines = fileContent.split('\n').filter(line => line.includes(';'));
        if (lines.length === 0) throw new Error('Invalid or empty euronext.csv file.');
        lines.forEach(line => {
            const columns = line.split(';');
            if (columns.length > 3 && columns[0] && columns[1] && columns[2]) {
                const [Name, ISIN, Symbol, Market, Currency, OpenPrice, HighPrice, lowPrice, lastPrice] = columns;
                newStockData.push({
                    Name: Name.replace(/"/g, ''), ISIN: ISIN.replace(/"/g, ''), Symbol: Symbol.replace(/"/g, ''),
                    Currency: Currency ? Currency.replace(/"/g, '') : 'N/A',
                    'last price': lastPrice ? lastPrice.replace(/"/g, '').trim() : '0',
                    'upload_date': new Date().toISOString(), 'datasource_name': 'euronext.csv'
                });
            }
        });
    } else if (fileName === 'us.csv') {
        const lines = fileContent.split('\n').filter(line => line.includes(','));
        if (lines.length === 0) throw new Error('Invalid or empty us.csv file.');
        lines.filter(l => !l.startsWith('Symbol,Name,')).forEach(line => {
            const [Symbol, Name, LastSale] = line.split(',');
            if (Symbol && Name && LastSale) {
                newStockData.push({
                    Name: Name, ISIN: "", Symbol: Symbol, Currency: "USD",
                    'last price': LastSale.replace(/\$/g, ''),
                    'upload_date': new Date().toISOString(), 'datasource_name': 'us.csv'
                });
            }
        });
    } else {
        throw new Error(`Unsupported stock file: ${fileName}`);
    }
    return newStockData;
};

const processRatesFile = (filePath) => {
    // ... (logic from previous step, no changes needed)
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const lines = fileContent.split('\n').filter(line => line.includes(','));
    if (lines.length < 2) throw new Error('Invalid rates file: requires header and data lines.');
    const headers = lines[0].split(',').map(h => h.trim());
    const values = lines[1].split(',').map(v => v.trim());
    const newRates = {};
    headers.forEach((header, index) => {
        if (header && header !== 'Date' && values[index]) newRates[header] = parseFloat(values[index]);
    });
    return { rates: newRates, upload_date: new Date().toISOString(), datasource_name: 'eurofxref.csv' };
};


// --- Multer and API Endpoints (remain the same) ---
const stockStorage = multer.diskStorage({
    destination: (req, file, cb) => { const uploadPath = 'data/'; fs.mkdirSync(uploadPath, { recursive: true }); cb(null, uploadPath); },
    filename: (req, file, cb) => { cb(null, file.originalname); }
});
const ratesStorage = multer.diskStorage({
     destination: (req, file, cb) => cb(null, 'data/'),
     filename: (req, file, cb) => cb(null, 'eurofxref.csv')
});
const stockUpload = multer({ storage: stockStorage });
const ratesUpload = multer({ storage: ratesStorage });

app.post('/upload/stocks', stockUpload.single('stockFile'), (req, res) => {
    if (!req.file) return res.status(400).send({ message: 'No file uploaded.' });
    try {
        const { originalname, path: filePath } = req.file;
        const newStockData = processStockFile(originalname, filePath);
        stockData[originalname] = newStockData;
        res.status(200).send({ message: `${originalname} processed successfully.`, records_loaded: newStockData.length });
    } catch (error) {
        res.status(400).send({ message: error.message });
    }
});
app.post('/upload/rates', ratesUpload.single('ratesFile'), (req, res) => {
    if (!req.file) return res.status(400).send({ message: 'No file uploaded.' });
    try {
        ratesData = processRatesFile(req.file.path);
        res.status(200).send({ message: 'Rates file processed successfully.', currencies_loaded: Object.keys(ratesData.rates).length });
    } catch (error) {
        res.status(400).send({ message: error.message });
    }
});
app.get('/search', (req, res) => {
    const { query } = req.query;
    const allStocks = Object.values(stockData).flat();
    if (!query) return res.status(200).json(allStocks);
    const searchQuery = query.replace(/%/g, '.*');
    const searchRegex = new RegExp(searchQuery, 'i');
    const results = allStocks.filter(stock => searchRegex.test(stock.Name) || searchRegex.test(stock.Symbol) || (stock.ISIN && searchRegex.test(stock.ISIN)));
    res.status(200).json(results);
});
app.get('/search/rates/:pattern', (req, res) => {
    const { pattern } = req.params;
    const match = pattern.match(/^EUR_(\w{3})$/);
    if (!match) return res.status(400).send({ message: "Invalid pattern. Use format EUR_{CURRENCY}." });
    const currency = match[1];
    if (!ratesData.rates || !ratesData.rates[currency]) return res.status(404).send({ message: `Currency '${currency}' not found.` });
    res.status(200).json({ pair: pattern, value: ratesData.rates[currency], upload_date: ratesData.upload_date, datasource_name: ratesData.datasource_name });
});

// --- Server Startup Logic (remains the same) ---
const initializeCache = () => {
    console.log('Attempting to initialize cache from /data directory...');
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) {
        console.log('Data directory not found. Server will start with an empty cache.');
        return;
    }
    const files = fs.readdirSync(dataDir);
    files.forEach(fileName => {
        const filePath = path.join(dataDir, fileName);
        try {
            if (fileName === 'euronext.csv' || fileName === 'us.csv') {
                const newStockData = processStockFile(fileName, filePath);
                stockData[fileName] = newStockData;
                console.log(`✅ Successfully loaded ${newStockData.length} records from ${fileName}.`);
            } else if (fileName === 'eurofxref.csv') {
                ratesData = processRatesFile(filePath);
                console.log(`✅ Successfully loaded ${Object.keys(ratesData.rates).length} currencies from ${fileName}.`);
            }
        } catch (error) {
            console.error(`❌ Failed to load or process ${fileName}: ${error.message}`);
        }
    });
};

initializeCache();

// ---  Start the server using HOST and PORT from environment variables ---
app.listen(PORT, HOST, () => {
    console.log(`Server is running on http://${HOST}:${PORT}`);
    console.log(`API documentation available at http://${HOST}:${PORT}/api-docs`);
});