# Simple IRC Client - Network Module

[![Build Status](https://github.com/Simple-Irc-Client/network/actions/workflows/ci.yml/badge.svg)](https://github.com/Simple-Irc-Client/network/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://github.com/Simple-Irc-Client/network/blob/main/LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D24-green.svg)](https://nodejs.org/)

A network service that bridges IRC servers with frontend applications via WebSocket.

## Features

- Real-time IRC server communication
- WebSocket API for frontend integration
- Support for multiple IRC networks
- Lightweight and fast

## Tech Stack

- [TypeScript](https://www.typescriptlang.org/)
- [ws](https://github.com/websockets/ws) - WebSocket server for frontend communication
- [irc-framework](https://github.com/kiwiirc/irc-framework) - IRC protocol client library

## Requirements

- Node.js >= 24

## Getting Started

### Installation

```bash
npm install
```

### Development

Start the development server:

```bash
npm run dev
```

The network service will be available at `http://localhost:8667`

## Docker

```bash
docker build -t sic-network .
docker run -p 8667:8667 sic-network
```

## Related Projects

- [Simple-Irc-Client](https://github.com/Simple-Irc-Client) - Main project organization

## Contributing

If you find a bug or have a feature request, please [open an issue](https://github.com/Simple-Irc-Client/network/issues) on GitHub.

## License

This project is licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](https://github.com/Simple-Irc-Client/network/blob/main/LICENSE).

The AGPL-3.0 license ensures that if you modify and deploy this software over a network, you must make the complete source code available to users.

**Authors:**

- [Piotr Luczko](https://www.github.com/piotrluczko)
- [Dariusz Markowicz](https://www.github.com/dmarkowicz)
