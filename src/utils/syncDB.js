const { sequelize } = require("../config/postgres");
const CodeReview = require("../models/CodeReview");

const syncDatabase = async () => {
  try {
    await sequelize.sync({ alter: true });
    console.log("PostgreSQL database synced successfully!");
  } catch (error) {
    console.error("Error syncing the database:", error);
  }
};

module.exports = syncDatabase;
