# Twilio gotchas — shared preparation snapshot

October 9, 2026. Documentation notes retain their October 6–9 source dates; execution statements below are historical preparation reports from October 7. They were not rerun for this export. Your account can differ.

1. **Select the right stack and host.** Core v2010, Messaging, Lookup and Verify have different base URLs. [Stack table](README.md).
2. **Basic authentication works in the pinned alpha.10.** The earlier alpha.9 refusal is historical. Use the two environment-variable references in the supplied config; do not replace them with a literal token.
3. **Check the operation's request encoding.** Verify-service and v2010-queue creates rejected JSON as a missing `FriendlyName`, then accepted form encoding in the preparation. Use `body_type: "form"` where the contract requires it. This is not evidence about every Twilio operation.
4. **401 can reflect account capability.** Trial Messaging-service creation and Verify-service deletion returned code `20003` with a Trial-feature message. Read the body; do not assume every 401 means a mistyped token. These results do not establish your current account status.
5. **Creating something does not guarantee you can delete it.** A Trial Verify service remained after a refused delete; a tested queue deletion returned 204 and a following GET returned 404. Check permissions and cleanup before creating resources.
6. **The FriendlyName experiment did not establish a universal character rule.** One hyphenated 22-character value failed while `SannrProbe` worked. Use documented constraints and inspect the actual error before inferring a regex.
7. **Test credentials cover selected resources only.** They did not establish Accounts/Verify access, MessagingServiceSid simulated sends or callback behavior. Read the [test-credential documentation](https://www.twilio.com/docs/iam/test-credentials).
8. **GET does not mean free.** Additional Lookup `Fields` can be billable. Review the [Lookup documentation](https://www.twilio.com/docs/lookup/v2-api) and [current pricing](https://www.twilio.com/en-us/user-authentication-identity/pricing/lookup) for the specific package.
9. **Messaging and Verify have account, recipient and time constraints.** See [trial restrictions](https://www.twilio.com/docs/usage/tutorials/how-to-use-your-free-trial-account), [A2P 10DLC](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc), and [Verify limits](https://www.twilio.com/docs/verify/api/rate-limits-and-timeouts). The operation notes preserve dated details; recheck before planning around a limit.
10. **Dev Phone changes selected-number webhooks.** Use a spare number you control and retain the original settings for cleanup. See [Dev Phone](https://www.twilio.com/docs/labs/dev-phone) and [voice prep](../VOICE-PREP.md).

No call, SMS, paid Lookup or delivery workflow was verified by this package. A request designed to fail sender validation is not a safe substitute for an explicit no-send test environment.
