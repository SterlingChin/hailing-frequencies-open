# Hailing Frequencies design system

This is the shared UI language for Hailing Frequencies Open. It turns the October 10, 2026 LCARS-inspired exploration into reusable guidance and framework-neutral CSS. The source concepts were an exploration, not evidence that any voice, SMS, or specialist integration works.

## Start here

1. Read this guide before building a screen. Use [`tokens.css`](tokens.css) and [`components.css`](components.css) as the implementation source of truth.
2. Open [`preview.html`](preview.html) to see the classes and invented demo content together. It is a static design preview, not an application flow.
   Static snapshots are available for [desktop](preview-desktop.png) and [390px mobile](preview-mobile.png).
3. Consult [`reference/DESIGN-BRIEF.md`](reference/DESIGN-BRIEF.md) and [`reference/concepts.dc.html`](reference/concepts.dc.html) for the original intent. The latter needs `reference/support.js` and an internet connection for its hosted fonts.
4. When adding a component, add its states and a small example here or in the preview. Reuse the `hf-` class and `--hf-` token prefixes.

## Chosen direction

The desktop live call uses the **ship bridge console**: a stable crew/context zone, a dominant conversation zone, and a specialist zone. The conversation borrows the **personal communicator**'s large captions and explicit listening/speaking state. The after-call recap and requested text follow-up use the **communications desk**'s ordered case timeline. On a narrow screen, collapse to the communicator pattern with context and tasks below the live line. These choices follow the recommendation in the source exploration; they are the working design direction for this repository.

LCARS framing organizes information. The colored rails identify zones and roles; they are not unlabeled controls. Keep one primary action per moment. Put the current speaker and next useful step ahead of equipment history and internal event detail. A case remains coherent when a call ends or a specialist reports late.

## Foundations

| Foundation | Rule |
| --- | --- |
| Color | Dark bridge base with amber structure, coral agent voice, lavender caller/Logistics, mint connection and ready states. Use the light desk surface for case records. Color always has a text label or glyph partner. |
| Type | Atkinson Hyperlegible for captions and body, Antonio for short console labels, IBM Plex Mono for case IDs, times, and metadata. Browser fallbacks are defined in CSS. |
| Scale | 8px spacing unit; 16px typical gutter; 8px inner corners; 28–56px console elbows. Keep captions large enough to read in a reduced recording. |
| Motion | A role change may transition in 150ms; a new result may enter by at most 12px. Motion never implies a task or delivery completed. Respect reduced motion. |
| Focus | Every interactive control needs a visible focus ring, text name, and keyboard path. Use actual buttons and links only when the action exists. |

The CSS tokens are scoped to `.hf-app`. Set `data-hf-theme="bridge"` or `data-hf-theme="desk"` on that root. Do not hard-code source concept colors inside new components. The font families can be loaded by the host application; the CSS still works without remote fonts.

## Layouts

| Surface | Structure | Behavior |
| --- | --- | --- |
| Live desktop | `hf-console`: context, conversation, specialist rail | Keep the caption and connection status stable while updates arrive. The specialist rail is secondary to speech. |
| Live mobile | One column: connection, caption, next action, then context and tasks | At about 390px, preserve readable captions and a useful task summary. Do not squeeze the desktop rails into tiny columns. |
| Case recap | `hf-timeline` on a light desk surface | Voice, specialist findings, and follow-ups share one ordered record. Pin or offer “Jump to live” only while a call is active and the reader has moved back. |

At a 1440×900 recording viewport, the live line should remain the strongest text. Avoid a second scrolling timeline beside the live conversation. If call controls belong to Twilio Dev Phone, show connection status in this UI and direct the user to that phone client for mute, microphone, and hang-up controls. Add embedded controls only after an embedded dialer exists.

## Component contracts

| Component | Required content | States and behavior |
| --- | --- | --- |
| Connection pill | Text status plus a shape/glyph | Connecting, connected, reconnecting, ended, failed. A reconnecting call is not presented as active. |
| Speaker label and caption | Speaker name, role, readable line | Listening, caller speaking, agent speaking, interrupted. Keep older lines reviewable without forced auto-scroll. |
| Specialist task card | Specialist, assignment, task status, relevant finding or recovery | Queued, working, delayed, result ready, failed, replaced. No fabricated progress percentage. A stale result is marked replaced after a symptom change. |
| Next-step card | Proposed action, evidence or source, confirmation state | Proposed and confirmed by caller are distinct. A possible cause is not a diagnosis confirmed by the caller. |
| Follow-up card | User request, chosen channel, destination label, message preview | Requested, queued/submitted, delivered, delivery not confirmed, failed. “Delivered” requires carrier confirmation. A channel preference alone never sends a message. |
| Context strip | Crew, ship, equipment, case ID | Keep the current context short; disclose history on demand. A contact number is not identity proof. |
| Case timeline | Time, event kind, actor, event text, status | Late results stay attached to their task and case and say they arrived after the call. |

## Copy and state rules

- Use plain actions: “Call support”, “Try again”, “Text me the details”, “Resume case”. The theatrical tone belongs in the greeting and frame, not in task labels.
- Use “Demo profile loaded” for the seeded spoken authorization. Never say “Voiceprint verified” without a real verification mechanism.
- Say “Engineering is checking…” while work is pending. If it fails, say it could not finish and offer a real recovery path. Do not show a finding from a failed task.
- Say “Possible cause” until the evidence supports more. Keep a proposed repair separate from the caller confirming that the problem is resolved.
- Label a message “queued” or “submitted” until delivery confirmation arrives. If confirmation is absent, say “Delivery not confirmed”.
- Keep preferences, one-off requests, and actual delivery records separate. Explain a channel choice in user language.
- Treat all names, cases, ship details, and phone labels in the preview as invented fixtures.

## Accessibility checklist for each screen

- The experience works with sound off: captions, speaker names, connection state, and specialist status are visible as text.
- At common browser zoom levels, content reflows without horizontal clipping. Focus indicators remain visible against dark and light surfaces.
- Decorative LCARS rails are hidden from assistive technology. Status changes are announced through an appropriate live region in the application; avoid announcing every partial caption.
- Respect `prefers-reduced-motion`. Do not rely on animation or color alone to convey the current state.
- Do not move a reader back to the newest timeline item while they review history.

## Provenance and maintenance

`reference/` is an unchanged local copy of the sibling design brief and exported concept HTML/JS. The concept HTML contains three desktop directions, two states for each, annotated flows, a visual comparison, and the recommendation summarized here. The original brief explicitly called the directions starting points rather than approved styles. This directory adopts their combined recommendation as a practical baseline for this repo. Keep the reference intact; evolve the tokens and component contracts when the product design changes.
