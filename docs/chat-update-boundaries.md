# Update controls in chat

Status: built.

An Odd can read the updater's status as its chat run starts and request a
fresh check. The owner sees the existing Updates controls under the reply.
Installation, restart and changing the install window remain owner actions
through the existing update route. The tool cannot choose a release, a
download address, an install time or an executable.

## Untrusted instructions

- A page, file, message or release note could tell an Odd to install code.
  The chat tool has no installation action. It can request only a check and
  show controls. Install now uses the existing check that the request came from the office's own page.
- A forged or stale request file could show controls or request a check.
  The office accepts only a valid request for the current successful chat
  run and consumes it once. A stopped or failed reply discards it. The file
  can never authorize installation, even if the Odd writes it itself.
- A tool argument could claim a newer version or a successful check.
  Status comes from the office's run environment, validated before reading;
  the model supplies none of it. The card loads live status from the existing
  owner route. Release notes are not copied into the tool's status.
- A background run could request a restart. The tool is offered only in
  owner chats and has no restart action. Scheduled installation remains the
  updater's existing owner-configured behavior.

The shell still downloads and verifies updates. The app's key, signing keys and
installer never reach an Odd. A requested check starts after the chat reply
is saved; the card shows its result as the updater reports it. A later chat
run reads the latest status. The tool must not call a pending check complete.
