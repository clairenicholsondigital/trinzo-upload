require('dotenv').config();

const path = require('path');
const express = require('express');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3978;

app.use(express.json({ limit: '25mb' }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.use('/api', apiRoutes);

app.listen(PORT, '0.0.0.0', () => {
  console.log('Agent listening on port ' + PORT);
});
