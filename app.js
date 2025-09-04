require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parse');

const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const swaggerDocument = YAML.load('./swagger.yaml');

const app = express();
const PORT = process.env.PORT || 3010;

const stockData = {
  bySymbol: {},
  byName: {},
  byIsin: {},
};

const currencyRates = {};

async function loadData() {
  const files = ['amex.csv', 'euronext.csv', 'nasdaq.csv', 'nyse.csv'];
  const promises = files.map(file => new Promise((resolve, reject) => {
    const filePath = path.join(__dirname, 'data', file);
    const parser = csv.parse({
      delimiter: file === 'euronext.csv' ? ';' : ',',
      columns: true,
      skip_empty_lines: true,
    });
    const records = [];
    const readStream = fs.createReadStream(filePath);
    readStream.on('error', (err) => {
      console.error(`Error reading file ${file}:`, err);
      reject(err);
    });
    readStream.pipe(parser)
      .on('data', (record) => records.push({ source: file, data: record }))
      .on('end', () => {
        records.forEach(record => {
          const { data } = record;
          // Index by Symbol
          if (data.Symbol) {
            stockData.bySymbol[data.Symbol] = record;
          }
          // Index by Name
          if (data.Name) {
            stockData.byName[data.Name.toLowerCase()] = record;
          }
          // Index by ISIN
          if (data.ISIN) {
            stockData.byIsin[data.ISIN] = record;
          }
        });
        console.log(`Indexed ${records.length} records from ${file}`);
        resolve();
      })
      .on('error', reject);
  }));

  const eurofxrefPromise = new Promise((resolve, reject) => {
    const filePath = path.join(__dirname, 'data', 'eurofxref.csv');
    const records = [];
    fs.createReadStream(filePath)
      .pipe(csv.parse({ columns: true, skip_empty_lines: true }))
      .on('data', (record) => records.push(record))
      .on('end', () => {
        if (records.length > 0) {
          const latestRecord = records[0]; // Assuming the first record is the latest
          const date = latestRecord.Date;
          for (const key in latestRecord) {
            if (key !== 'Date' && key.trim()) {
              const symbol = `EUR_${key.trim()}`;
              currencyRates[symbol] = {
                value: parseFloat(latestRecord[key]),
                date: date,
              };
            }
          }
          console.log(`Loaded ${Object.keys(currencyRates).length} currency rates.`);
        }
        resolve();
      })
      .on('error', reject);
  });

  await Promise.all([...promises, eurofxrefPromise]);
  console.log('All files loaded and indexed.');
}

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

app.get('/search', (req, res) => {
  const { query, by } = req.query;
  if (!query || !by) {
    return res.status(400).json({ error: 'Missing query or by parameter.' });
  }

  let index;
  switch (by.toLowerCase()) {
    case 'symbol':
      index = stockData.bySymbol;
      break;
    case 'name':
      index = stockData.byName;
      break;
    case 'isin':
      index = stockData.byIsin;
      break;
    default:
      return res.status(400).json({ error: 'Invalid search parameter "by". Use symbol, name, or isin.' });
  }

  const results = Object.keys(index)
    .filter(key => key.toLowerCase().includes(query.toLowerCase().replace(/%/g, '')))
    .map(key => index[key]);

  if (results.length === 0) {
    return res.status(404).json({ message: 'No records found.' });
  }

  res.json(results);
});

app.get('/rates', (req, res) => {
  const { symbol } = req.query;

  if (Object.keys(currencyRates).length === 0) {
    return res.status(404).json({ message: 'Currency rates not loaded.' });
  }

  if (symbol) {
    const rate = currencyRates[symbol.toUpperCase()];
    if (rate) {
      return res.json([ { symbol: symbol.toUpperCase(), ...rate } ]);
    } else {
      return res.status(404).json({ message: `No rate found for symbol: ${symbol}` });
    }
  }

  const allRates = Object.keys(currencyRates).map(key => ({
    symbol: key,
    ...currencyRates[key]
  }));

  res.json(allRates);
});


async function startServer() {
  try {
    console.log('Loading data from files...');
    await loadData();
    app.listen(PORT, () => {
      console.log(`Server is running on http://localhost:${PORT}`);
      console.log(`Swagger UI available at http://localhost:${PORT}/api-docs`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
  }
}

startServer();
