# Claude Code connection

For a Claude subscription, Psi uses the installed, unmodified Claude Code CLI. Claude Code performs sign-in and refreshes its own credentials. Psi stores only a reference to the chosen native configuration, with no copied access or refresh token.

Open **/accounts → Login a new account → Claude Code**, name the account, and choose **Use existing login**. To connect another account, choose **Connect another account**: the native CLI signs in with a separate configuration directory. Your usual Claude Code login is preserved. The older Anthropic subscription menu also routes to this native connection.

Install Claude Code first if it is missing. Its executable path can be changed under **/settings → Claude Code path**. If sign-in fails, run these in a terminal:

```sh
claude --version
claude auth status
claude auth login
```

Choose the native provider's model in **/model**; typing **claude-code** filters its entries. Anthropic API keys remain a separate direct API connection.

## How execution works

Psi supplies the conversation and a structured response schema to Claude Code print mode. The native CLI returns user text and requested Psi tool calls. Psi executes those calls through its existing tool validation, plan/execute mode and directory boundaries, then sends their results on the next turn.

The bridge disables the CLI's own tools, external MCP servers, skills, user/project settings and hooks. It runs from a temporary empty working directory and disables native session persistence and auto memory. The parent Psi journal remains the source of task history. The default native login deliberately leaves CLAUDE_CONFIG_DIR unset: explicitly setting it to the ordinary default directory can select a different keychain service on macOS.

## Limits and verification

- Requires a current native Claude Code CLI supporting print mode, structured output, auth status and the listed configuration flags. Psi does not modify the binary.
- This bridge currently accepts text and tool results. Use the direct Anthropic API connection for image messages.
- User text appears when the native structured response completes; Psi continues to display request activity and its own tool events.
- Native calls have a three-turn ceiling for producing structured output. Their internal turns can add latency and usage. Reported input/output/cache tokens are counted; cost is estimated using model rates, not treated as a subscription invoice.
- The output-token setting is forwarded to the native CLI. Its per-native-request output cap is not a total cap over all native internal turns.
- Native subscription quota/reset data is not exposed through a supported CLI usage endpoint. Psi does not copy tokens to scrape private usage APIs or invent quota windows.
- Local tests cover native account routing, tool/result round trips, separate configuration selection, cancellation, rejected responses and legacy worker migration using fixture responses. Native login status was checked on the development laptop. No paid Claude inference was used to validate this release, so live model availability and an actual server response remain unverified.

Primary references: [native authentication and multiple accounts](https://code.claude.com/docs/en/authentication), [programmatic execution](https://code.claude.com/docs/en/headless), [CLI options](https://code.claude.com/docs/en/cli-reference), and [authentication and credential use](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).
