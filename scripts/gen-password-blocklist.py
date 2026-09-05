#!/usr/bin/env python3
"""Generate src/util/password_blocklist.bin from wordlists on stdin.

The blocklist holds truncated SHA-256 hashes, not plaintext.

Two reasons. A source file full of real passwords is indistinguishable from
leaked credentials to a secret scanner — the previous hand-written array of
fifty literals was reported by GitGuardian as "Generic Password" incidents,
and a scanner that cries wolf on its own repository trains people to ignore
it. And hashing means the list can come from a real breach corpus and hold
tens of thousands of entries without any of it being readable in the tree.

Entries are 8-byte SHA-256 prefixes, sorted, so the lookup is a binary search
over an @embedFile'd blob. A collision would reject one arbitrary password
that shares a 64-bit prefix with a listed one; for a list this size that is
around one in 10^15, and the failure mode is "choose a different password".

Only passwords that would otherwise satisfy validatePasswordStrength are
kept — anything shorter than 8 characters, or without both a letter and a
digit, is already refused by the composition rules and would only bloat the
file.

Usage:
    cat wordlist1.txt wordlist2.txt \\
      | scripts/gen-password-blocklist.py src/util/password_blocklist.bin

Wordlists are not committed. SecLists' Passwords/Common-Credentials is a
reasonable source; any newline-separated list works.
"""
import hashlib
import sys

PREFIX_BYTES = 8


def worth_listing(word: str) -> bool:
    if not 8 <= len(word) <= 128:
        return False
    return any(c.isalpha() for c in word) and any(c.isdigit() for c in word)


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    out_path = sys.argv[1]

    digests = set()
    for line in sys.stdin:
        word = line.strip()
        if word and worth_listing(word):
            # Matching is case-insensitive, so store the folded form.
            digests.add(hashlib.sha256(word.lower().encode()).digest()[:PREFIX_BYTES])

    with open(out_path, "wb") as f:
        for d in sorted(digests):
            f.write(d)

    print(f"{len(digests)} entries -> {out_path} "
          f"({len(digests) * PREFIX_BYTES} bytes)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
