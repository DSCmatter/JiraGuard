const fs = require('fs');

const token = fs.readFileSync('.spike-token', 'utf8').trim();
const url = fs.readFileSync('.webtrigger-url', 'utf8').trim();

async function main() {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'guard_whoami', arguments: { probe: 'jira' } }
    })
  });
  const text = await res.text();
  console.log(res.status, text.split(token).join('[token]').slice(0, 2000));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
