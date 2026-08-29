// One out-of-process witness advance through the REAL advanceWitness, so the
// concurrency suite exercises genuine cross-process serialisation rather than
// two calls on one thread. argv: <witnessPath> <pairId> <direction> <e> <s> <a>
import { advanceWitness } from "../../src/cli/v2/witness.ts";

const [, , path, pairId, direction, enc, seq, att] = process.argv;
advanceWitness(path, pairId, direction, {
  encryptionNextOffset: Number(enc),
  authenticationNextSequence: Number(seq),
  attemptsReserved: Number(att)
});
