require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const connectMongoDB = require('./config/mongo');
const { connectPostgres } = require('./config/postgres');
const syncDB = require('./utils/syncDB');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(cors());

// Versioned Routes
const reviewRoutes = require('./routes/reviewRoutes');
const userRoutes = require('./routes/userRoutes');

// Routes
app.use('/api/v1/reviews', reviewRoutes);
app.use('/api/v1/users', userRoutes);

const startServer = async () => {
  try {
    await connectMongoDB();
    await connectPostgres();
    await syncDB();
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Error starting the server:', err);
  }
};

startServer();