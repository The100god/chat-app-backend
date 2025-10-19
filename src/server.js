const app = require('./app');
const {createServer} = require("http");

const PORT = process.env.PORT || 5000;
const httpServer = createServer(app);
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
