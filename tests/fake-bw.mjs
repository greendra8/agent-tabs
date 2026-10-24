#!/opt/homebrew/bin/node
// Stand-in for the Bitwarden CLI in tests: one login, with an authenticator key, for 127.0.0.1.
const [command, sub, arg] = process.argv.slice(2);
const item = { id: "fake-1", type: 1, name: "Fixture login", login: { username: "agent@example.com", password: "correct horse", totp: "JBSWY3DPEHPK3PXP" } };
if (command === "sync") process.exit(0);
if (command === "list" && sub === "items") {
  const url = process.argv[process.argv.indexOf("--url") + 1];
  console.log(JSON.stringify(url.includes("127.0.0.1") ? [item] : []));
} else if (command === "get" && sub === "totp" && arg === item.id) {
  console.log("123456");
} else {
  console.error(`fake-bw: unsupported ${process.argv.slice(2).join(" ")}`);
  process.exit(1);
}
