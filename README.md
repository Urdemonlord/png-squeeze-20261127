# PNG Squeeze

[![Squeeze screenshots into the smallest PNG](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![Rank](https://make.fun/badge/png-squeeze-01-run-20261127/Urdemonlord/png-squeeze-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![Reward](https://make.fun/badge/png-squeeze-01-run-20261127/Urdemonlord/png-squeeze-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

Lossless PNG recompressor for the [png-squeeze-01-run-20261127](https://make.fun/bounty/png-squeeze-01-run-20261127) bounty. One program, `main.ts` at the repo root, reads 8 screenshots of 1280 by 720 RGBA from `/input/<id>/image.png` and writes the smallest lossless PNG it can to `/output/<id>/image.png`, inside 60 seconds for the whole set. Pure Node, no dependencies, deterministic: two runs write byte-identical files.

Practice set score: **720,939** (house baseline fixed-paeth 1.0.0 scores 420,399).

| instance | theme | points |
| --- | --- | --- |
| i001 | flat | 721.372 |
| i002 | rich | 722.429 |
| i003 | alpha | 719.182 |
| i004 | grey | 729.717 |
| i005 | flat | 742.251 |
| i006 | rich | 714.963 |
| i007 | alpha | 701.871 |
| i008 | grey | 715.725 |

## How it works

1. **Decode** the stored input PNG (colour type 6, unfiltered) to RGBA.
2. **Screen forms.** Palette (by count, by luminance, and by a greedy nearest-neighbour walk in RGB space, transparent entries first), grey, grey plus alpha, RGB, RGBA, plus a tRNS-key form when the image has a single transparent value. Each form is tried with fixed filters, minimum-sum, fewest-pairs, and per-row brute-force filter choice, weighed by zlib level 6.
3. **Compress the winner** with a zopfli-style DEFLATE written from scratch: hash-chain LZ77 match finder (longest match plus the longest nearby match, distances under 1024), shortest-path optimal parse over both candidates, iterated dynamic Huffman tables, 512 KiB blocks. The stream is kept only when it beats zlib level 9 on the same filtered data.
4. **Write** a strict PNG: IHDR, PLTE and tRNS only when needed, one IDAT zlib stream, IEND.

## Run it locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`SQUEEZE_CHAIN`, `SQUEEZE_BREAK`, `SQUEEZE_ITERS` and `SQUEEZE_BLOCK` tune the match finder, the parse iterations and the block size. Defaults are what scored 720,939 on the practice set.

## License

MIT. See LICENSE.
