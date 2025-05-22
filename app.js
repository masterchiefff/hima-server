require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const authRoutes = require('./routes/authRoutes');
const policyRoutes = require('./routes/policyRoutes');
const winston = require('winston');

const app = express();

// Logger setup
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({ format: winston.format.simple() }));
}

// Middleware
app.use(cors());
app.use(express.json());

// Connect to MongoDB
connectDB();

// Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/policies', policyRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error(`${err.message}`);
  res.status(500).json({ message: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT} at ${process.env.NODE_ENV === 'production' ? process.env.RENDER_BASE_URL : 'http://localhost:5000'}/api/v1/`);
});