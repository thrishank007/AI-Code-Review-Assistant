const { sequelize } = require('../config/postgres');

const syncDB = async () => {
  try {
    await sequelize.sync({ force: false }); // Set force: true to drop tables and recreate them
    console.log('Database synced successfully');
  } catch (error) {
    console.error('Database sync failed:', error);
    process.exit(1);
  }
};

module.exports = syncDB;