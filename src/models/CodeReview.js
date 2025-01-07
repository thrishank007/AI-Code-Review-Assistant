const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/postgres");

// CodeReview model
const CodeReview = sequelize.define("CodeReview", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  fileName: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  reviewComments: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  createdBy: {
    type: DataTypes.STRING,
    allowNull: false,
  },
});

module.exports = CodeReview;
