const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/postgres');

const ReviewLog = sequelize.define('ReviewLog', {
  logId: {
    type: DataTypes.STRING,
    primaryKey: true,
    allowNull: false,
    defaultValue: DataTypes.UUIDV4,
  },
  reviewId: {
    type: DataTypes.STRING,
    allowNull: false,
    references: {
      model: 'CodeReviews',
      key: 'reviewId',
    },
  },
  log: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  createdAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
  updatedAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
});

module.exports = ReviewLog;