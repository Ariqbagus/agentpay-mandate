#!/usr/bin/env python3
"""Verify compiled artifacts contain no Cancun-only opcodes.

Aevum Testnet is EVM Shanghai. Cancun bytecode deploys fine but reverts with
"invalid opcode" at call time, so this scanner walks the deployed bytecode
instruction by instruction (skipping PUSH data, where opcode byte values can
legitimately appear as constants) and fails if it finds a Cancun opcode.

Usage: python3 tools/check-shanghai.py [out-dir]
Exit code 0 = clean, 1 = Cancun opcode found or artifact missing.
"""
import json
import sys
from pathlib import Path

CANCUN_OPCODES = {
    0x49: "BLOBHASH",
    0x4A: "BLOBBASEFEE",
    0x5C: "TLOAD",
    0x5D: "TSTORE",
    0x5E: "MCOPY",
}


def scan(bytecode: bytes) -> list[tuple[int, int, str]]:
    # Strip the trailing CBOR metadata: its last two bytes are its length.
    # The metadata is a hash blob, not instructions; walking into it desyncs
    # the disassembly and produces false positives.
    if len(bytecode) >= 2:
        meta_len = int.from_bytes(bytecode[-2:], "big") + 2
        if 0 < meta_len < len(bytecode):
            bytecode = bytecode[:-meta_len]
    hits = []
    i = 0
    while i < len(bytecode):
        op = bytecode[i]
        if op in CANCUN_OPCODES:
            hits.append((i, op, CANCUN_OPCODES[op]))
        if 0x60 <= op <= 0x7F:  # PUSH1..PUSH32: skip the immediate data
            i += op - 0x5F
        i += 1
    return hits


def main() -> int:
    out_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "out")
    artifacts = sorted(out_dir.rglob("*.json"))
    checked = 0
    failed = False
    for artifact in artifacts:
        try:
            data = json.loads(artifact.read_text())
        except (ValueError, OSError):
            continue
        # Only the project's own contracts (src/), not forge-std/test helpers.
        targets = ((data.get("metadata") or {}).get("settings") or {}).get("compilationTarget") or {}
        if targets and not next(iter(targets)).startswith("src/"):
            continue
        deployed = (data.get("deployedBytecode") or {}).get("object") or ""
        if not deployed or deployed == "0x":
            continue
        checked += 1
        hits = scan(bytes.fromhex(deployed.removeprefix("0x")))
        name = artifact.relative_to(out_dir)
        if hits:
            failed = True
            for offset, op, label in hits:
                print(f"FAIL {name}: Cancun opcode {label} (0x{op:02x}) at byte offset {offset}")
        else:
            print(f"OK   {name}: no Cancun opcodes in {len(deployed) // 2} bytes of deployed bytecode")
    if checked == 0:
        print("No compiled artifacts found. Run `forge build` first.")
        return 1
    print(f"\nChecked {checked} artifact(s): {'FAILED' if failed else 'all Shanghai-clean'}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
