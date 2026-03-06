const http = require("http");

http.createServer((req, res) => {
  res.writeHead(301, { Location: "https://discordapp.com/invite/officialsupport" });
  res.end();
}).listen(3000, () => console.log("Redirect server running on http://localhost:3000"));