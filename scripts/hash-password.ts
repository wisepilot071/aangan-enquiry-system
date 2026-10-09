import { hashPassword } from "../src/modules/authentication";

const pw = process.argv[2];
if (!pw || pw.length < 12) {
  console.error("Usage: npm run admin:hash -- '<password of at least 12 characters>'");
  process.exit(1);
}
console.log(hashPassword(pw));
