# Releasing and distribution

## v0.1.0

`v0.1.0` is the first public GitHub preview. Its distribution package is
`yald-dashboard-0.1.0.tgz`; the executable is `yald`. The package contains the
built UI, server sources, launcher, and user documentation, with tests and design
studies excluded. The release also includes `SHA256SUMS`.

The repository's CI checks Linux and macOS on pull requests, `main`, and version
tags. CI does not automatically publish npm packages or create GitHub releases.
GitHub publication, npm publication, and Homebrew distribution are separate steps.

## Publish the same package to npm

The unscoped name `yald` is already taken; keep `yald-dashboard` as the package
name and `yald` as the command. Public packages are free
([npm pricing](https://www.npmjs.com/products)). Before first publication, create
or use an npm account with a verified email and two-factor authentication.

Download the tested artifact and publish it without repacking:

```bash
release_dir="$(mktemp -d)"
gh release download v0.1.0 --repo Collaboration95/yald \
  --pattern 'yald-dashboard-0.1.0.tgz' --pattern SHA256SUMS --dir "$release_dir"
cd "$release_dir"
shasum -a 256 -c SHA256SUMS
npm login
npm publish ./yald-dashboard-0.1.0.tgz --access public
npm view yald-dashboard@0.1.0 version
npm install -g yald-dashboard@0.1.0
yald --version
yald --open
```

Complete the npm browser login and any 2FA prompt yourself. The account used for
the first publication becomes the package owner. A package version cannot be
reused for changed contents; make a new version for later fixes. npm's
[publishing guide](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)
describes account and publication requirements.

For later releases, configure a dedicated workflow with
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and OIDC.
This avoids a persistent publishing token. Its current npm 11.5.1+ and Node
22.14.0+ requirements apply to the publishing workflow.

## Add Homebrew distribution

Start with a project-owned tap, `Collaboration95/homebrew-tap`, and a formula
named `yald`. Homebrew charges no listing fee for a tap
([tap guide](https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap)). npm
publication is not required if the formula downloads the GitHub release artifact.

1. Make an empty local Git repository for the tap and create `Formula/yald.rb`.
2. Use the formula template below with the exact package SHA-256 from the release's
   `SHA256SUMS`. It installs dependencies under the formula's own `libexec`.
3. Validate the formula locally with `brew style Formula/yald.rb`, then test it
   from the tap with `brew install --build-from-source` and `brew test` before
   recommending it to users. Include a real dashboard startup and API-health
   check in the formula test before publishing the tap.
4. Commit the formula and publish the new repository using authenticated gh:
   `gh repo create Collaboration95/homebrew-tap --public --source . --push`.
5. Users can then run `brew install Collaboration95/tap/yald`, followed by
   `yald --open`. Each future version updates the formula URL and checksum.

Starter formula (requires Homebrew installation testing before tap publication):

```ruby
class Yald < Formula
  desc "Read-only analytics dashboard for opencodex usage, cost, and quota"
  homepage "https://github.com/Collaboration95/yald"
  url "https://github.com/Collaboration95/yald/releases/download/v0.1.0/yald-dashboard-0.1.0.tgz"
  version "0.1.0"
  sha256 "REPLACE_WITH_RELEASE_SHA256"
  license "MIT"

  depends_on "node"

  def install
    # Bun's npm dependency needs its install script to select its platform runtime.
    system "npm", "install", *std_npm_args(ignore_scripts: false)
    bin.install_symlink libexec.glob("bin/yald")
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/yald --version").strip
  end
end
```

This is an own-tap starting point, not a claim that the formula has been tested
or accepted into Homebrew's official repositories. Follow the
[Node formula guidance](https://docs.brew.sh/Language-Specific-Formulae#nodejs)
and add a functional startup test before publication. An official listing can
be considered later under the
[formula acceptance requirements](https://docs.brew.sh/Acceptable-Formulae).

## Subsequent releases

- Record user-facing changes under Unreleased in `CHANGELOG.md`.
- At release time, move those entries into a dated version section and update
  `package.json` and any versioned release notes consistently.
- Keep 0.x until the upstream contract and metric definitions are stable.
- Build and inspect the package, install it in a clean directory, and run CLI,
  API, static-asset, typecheck, lint, test, build, and fixture smoke checks.
- Merge verified release work to `main`, tag the exact commit, and upload the
  tested package and checksums to its GitHub release.
- Publish the same artifact to npm and update the tap separately.

External launch posts and repository settings are separate from package
publication; existing drafts remain in `docs/launch-drafts.md`.
