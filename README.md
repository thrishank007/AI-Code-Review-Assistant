# AI-Code-Review-Assistant
An open-source AI-powered tool to automate code reviews and improve code quality.

## Description

The AI Code Review Assistant is a web application that leverages AI models to perform automated code reviews. 🛠️✨ It uses MongoDB for storing AI-generated code review data and PostgreSQL for user authentication and structured data. 📊🔒

## Features

- **AI Code Review**: Automatically analyze code using various AI models (OpenAI, Gemini, Claude, Qwen). 🤖📋
- **User Authentication**: Register and log in users with role-based access control. 🔑👤
- **Review Logs**: Log interactions and events related to code reviews. 🗂️🖋️
- **Hybrid Database**: Uses MongoDB for unstructured data and PostgreSQL for structured data. 🗄️📂

## Technologies Used

- **Backend**: Node.js, Express.js ⚙️
- **Databases**: MongoDB, PostgreSQL 🛢️
- **AI Models**: OpenAI, Gemini, Claude, Qwen 🌟
- **Authentication**: JSON Web Tokens (JWT) 🔒
- **Validation**: Express Validator ✅

## Prerequisites

- Node.js and npm installed on your machine. 💻
- MongoDB and PostgreSQL installed and running. 🛢️⚡
- API keys for OpenAI, Gemini, Claude, and Qwen. 🔑

## Setup

### 1. Clone the Repository

```sh
git clone https://github.com/thrishank007/AI-Code-Review-Assistant.git
cd AI-Code-Review-Assistant
```

### 2. Install Dependencies

```sh
npm install
```

### 3. Configure Environment Variables

Create a `.env` file in the root directory and add the following environment variables:

```
MONGODB_URI=mongodb://localhost:27017/code_review_ai
POSTGRES_USER=YOUR_USERNAME
POSTGRES_HOST=localhost
POSTGRES_DB=code_review_ai
POSTGRES_PASSWORD=YOUR_PASSWORD
POSTGRES_PORT=5432
JWT_SECRET=YOUR_JWT_TOKEN
OPENAI_API_KEY=YOUR_OPENAI_KEY
GEMINIAI_API_KEY=YOUR_GEMINIAI_KEY
ANTHROPIC_API_KEY=YOUR_ANTHROPIC_KEY
OLLAMA_URI=http://localhost:11434/
PORT=3000
```

Replace placeholders with your actual values. ✏️

### 4. Set Up PostgreSQL

1. **Install PostgreSQL**: Follow the instructions in the [PostgreSQL Installation Guide](https://www.postgresql.org/docs/current/installation.html). 🛠️

2. **Create Database and User**:

Access PostgreSQL:

```sh
sudo -i -u postgres
psql
```

Create database and user:

```sql
CREATE DATABASE code_review_ai;
CREATE USER yourusername WITH ENCRYPTED PASSWORD 'yourpassword';
GRANT ALL PRIVILEGES ON DATABASE code_review_ai TO yourusername;
\q
exit
```

### 5. Start the Server

```sh
npm start
```

or

```sh
node src/server.js
```

You should see output similar to this:

```
Connected to MongoDB
Connected to PostgreSQL using Sequelize!
Database synced successfully
Server is running on port 3000
```

## Endpoints

### User Endpoints

#### Register a New User:
- **Method**: POST
- **URL**: `/api/v1/users/register`
- **Body**:

```json
{
  "username": "testuser",
  "email": "test@example.com",
  "password": "password123"
}
```

#### Login a User:
- **Method**: POST
- **URL**: `/api/v1/users/login`
- **Body**:

```json
{
  "email": "test@example.com",
  "password": "password123"
}
```

### Review Endpoints

#### Get All Reviews:
- **Method**: GET
- **URL**: `/api/v1/reviews`
- **Headers**:

```
Authorization: Bearer YOUR_JWT_TOKEN
```

#### Add a New Review:
- **Method**: POST
- **URL**: `/api/v1/reviews`
- **Headers**:

```
Authorization: Bearer YOUR_JWT_TOKEN
Content-Type: application/json
```

- **Body**:

```json
{
  "code": "console.log(\"Hello, World!\");",
  "modelName": "openai" // openai,qwen,gemini,claude modelnames
}
```

#### Delete a Review:
- **Method**: DELETE
- **URL**: `/api/v1/reviews/:reviewId`
- **Headers**:

```
Authorization: Bearer YOUR_JWT_TOKEN
```

## Contributing

Contributions are welcome! ✨ Please follow these guidelines:

1. Fork the repository. 🍴
2. Create a new branch for your feature or bug fix. 🌱
3. Make your changes and commit them. 🛠️
4. Push your changes to your fork. 🚀
5. Submit a pull request to the main branch of the original repository. 📩

## License

This project is licensed under the GNU GENERAL PUBLIC LICENSE - see the [LICENSE](./LICENSE) file for details. 📜

## Contact

- **Author**: Thrishank Chintham 👤
- **Email**: rose@blushy.dev / thrishankchintham@gmail.com 📧
- **GitHub**: [thrishank007](https://github.com/thrishank007) 🌐