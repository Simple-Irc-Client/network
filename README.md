## Simple Irc Client network module

[![Build Status](https://github.com/Simple-Irc-Client/network/actions/workflows/ci.yml/badge.svg)](https://github.com/Simple-Irc-Client/network/actions/workflows/ci.yml)

This is a network service that receives data from an IRC server and sends it to a frontend application via WebSocket.

## Tech Stack

- [TypeScript](https://www.typescriptlang.org/)
- [ws](https://github.com/websockets/ws) - WebSocket server for frontend communication
- [irc-framework](https://github.com/kiwiirc/irc-framework) - IRC protocol client library

## Requirements

- Node.js >= 24

## Usage

### Development

Start the development server:

```bash
npm install
npm run dev
```

The network service will be available at `http://localhost:8667`

The service will listen for client/server messages and forward them to the frontend application.

## Docker

Run using Docker:

```bash
docker build -t sic-network .
docker run -p 8667:8667 sic-network
```

## Contributing

If you find a bug or would like to contribute to the project, please open an issue or submit a pull request on GitHub.

## License

This project is licensed under the [Affero General Public License version 3 (AGPLv3)](https://github.com/Simple-Irc-Client/network/blob/main/LICENSE).

## Authors

- [Piotr Luczko](https://www.github.com/piotrluczko)
- [Dariusz Markowicz](https://www.github.com/dmarkowicz)
