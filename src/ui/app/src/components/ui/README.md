# shadcn/ui primitives (new-york)

Vendored stock [shadcn/ui](https://ui.shadcn.com) components (MIT) in the *new-york*
style, tuned against the token sheet in `../../styles/theme-tokens.css`. Attribution for
the copied source is in `THIRD-PARTY-NOTICES.md` at the repository root.

Every file here is imported by the app. If a future ticket needs another primitive
(`tooltip`, `badge`, `dropdown-menu`, …), add it in the same *new-york* style so the set
stays one design system rather than two drifting ones.

Treat these as vendored: if one needs a behaviour change, prefer wrapping it in
`../` over editing it here, so the next `shadcn` update stays a clean diff.
