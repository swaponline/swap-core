curl http://127.0.0.1:7078/ --user test:test --data-binary '{"jsonrpc":"1.0","id":"curltext","method":"getblockchaininfo","params":[]}' -H 'content-type:text/plain;' -v