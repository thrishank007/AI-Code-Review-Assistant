const { Sequelize } = require("sequelize");
require("dotenv").config();
const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  password: process.env.PG_PASSWORD,
  port: process.env.PG_PORT,
});
// Initialize Sequelize instance
const sequelize = new Sequelize(
  process.env.PG_DATABASE,
  process.env.PG_USER,     
  process.env.PG_PASSWORD, 
  {
    host: process.env.PG_HOST,
    port: process.env.PG_PORT,
    dialect: "postgres",  
    logging: false,
  }
);


const connectPostgres = async () => {
  try {
    await sequelize.authenticate();
    console.log("Connected to PostgreSQL using Sequelize!");
  } catch (error) {
    console.error("PostgreSQL connection error:", error);
    process.exit(1);
  }
};

module.exports = { pool, sequelize, connectPostgres };
