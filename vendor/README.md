# Vendored SheetJS CE

`xlsx-0.20.3.tgz` is the official SheetJS Community Edition 0.20.3 package
tarball, downloaded byte-for-byte from:

<https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz>

SHA-256:

```text
8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8
```

The embedded `package/package.json` identifies the archive as `xlsx@0.20.3`.
The root `package.json` intentionally references this repository-local archive
with `file:vendor/xlsx-0.20.3.tgz`; ordinary `npm ci` and `npm install` must
therefore not fetch SheetJS from the CDN.

To update this dependency, obtain the intended official SheetJS CE tarball,
verify its SHA-256 and embedded package name/version, replace the archive,
update this source-and-hash record, then regenerate `package-lock.json` with
npm and run the workbook import/export regression tests.
