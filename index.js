require('dotenv').config();

// Accessing .env variables
const mongoURI = process.env.MONGO_URI;
const pgHost = process.env.PG_HOST;
const pgUser = process.env.PG_USER;
const pgPassword = process.env.PG_PASSWORD;
const pgDatabase = process.env.PG_DATABASE;
const pgPort = process.env.PG_PORT;
const port = process.env.PORT;

console.log(`MongoDB URI: ${mongoURI}`);
console.log(`PostgreSQL Host: ${pgHost}`);
