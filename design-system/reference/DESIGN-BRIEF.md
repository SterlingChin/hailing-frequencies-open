# Hailing Frequencies Open UI Design Brief

Prepared for a design agent working with Sterling Chin and Michael Watson on their Web Dev Challenge project. October 10, 2026.

Design several possible interfaces for a personal Federation support agent that knows the caller, brings in specialist agents, and continues helping across voice and text. The immediate assignment is UI exploration: establish the visual direction, screen structure, and interaction behavior before production implementation.

The central design question is: **How do we make a natural voice conversation feel personal, while showing enough of the specialists' work that a caller and a video audience can understand what is happening?**

## Product and team context

The team name is **Hailing Frequencies Open**. Use it as the working application name for these concepts; a separate product name has not been chosen.

The opening tagline is **“The Federation is always watching.”** It is a joke between the teammates and should be delivered with warmth and a little theatrical confidence. Follow it with “Hailing frequencies open.” The joke should feel like friendly science fiction rather than a claim that the app is secretly monitoring people.

Michael proposed the team name, tagline, channel-aware specialist agents, Railway hosting, and camera-assisted support. Sterling proposed Federation technical support, a personal agent with equipment history, the spoken authorization sequence, and desktop calling for the show's recording workflow. Both want OpenAI and Twilio in the experience. These contributions explain the concept; they are not fixed assignments of implementation work.

The product promise is: **Your personal Federation agent knows your situation, finds the right expert, and follows up through the channel you prefer.**

Possible support cases include malfunctioning replicators, replacement parts, and eventually a playful Borg emergency. The first design should center on one replicator problem. The spectacle should come from understandable agent collaboration and continuity across channels.

## People and viewing conditions

The primary user is a fictional crew member who wants help while talking naturally. They should be able to interrupt, correct a symptom, request a text, and return later without explaining everything again.

The second audience is the viewer watching the challenge recording. They need to recognize who is speaking, which specialist is working, and what changed. They should be able to follow the demo even with the sound off.

The main presentation is on a Mac with a browser calling interface and the application visible. A responsive mobile companion matters, especially for a future photo upload. The initial web interface is a case companion and mission console; it should still make sense when the phone call occurs in another app.

## Core demonstration

Use this sequence to organize the screens and transitions:

1. The crew member opens the app and sees a clear way to contact support, plus their fictional ship and equipment context.
2. They call support from the desktop phone interface. The agent greets them with the tagline and “Hailing frequencies open.”
3. They say a fictional authorization sequence. The app loads the seeded crew profile and shows its equipment and preferences.
4. They say, “My replicator is making cold coffee.” The personal agent already has the replicator model and relevant history.
5. Engineering investigates. The caller can continue speaking or correct the problem. The interface shows useful progress without demanding attention.
6. Engineering returns a repair suggestion grounded in the fictional catalog. The caller sees the next step and hears a concise explanation.
7. In the fuller version, Logistics checks a compatible replacement part. Make the transition from diagnosis to parts support visible.
8. The caller says, “Text me the details.” The app records that request and shows the actual delivery status.
9. The call ends. The case remains available with its diagnosis, next step, and follow-up. A later SMS reply can continue the same case once that feature is implemented.

The smallest complete version ends with an Engineering diagnosis and a requested SMS recap. Logistics, SMS continuation, photos, and callbacks can be layered onto that experience.

## Agent roles and channel behavior

| Role | What it contributes | What the user should see |
| --- | --- | --- |
| Personal concierge | Loads personal context, holds the conversation, brings in specialists, explains results | One consistent conversational presence and a clear sense that it remembers the case |
| Engineering | Diagnoses the equipment fault and retrieves repair guidance | Its assignment, working status, relevant findings, and suggested next step |
| Logistics | Checks compatible parts and fictional fulfillment options | The requested part, availability, and proposed follow-up |

The specialists can share a backend while having separate prompts, knowledge, and permitted tools. Do not make their interfaces imply separate phone calls or audible voice transfers unless that behavior is explicitly added.

Michael's channel idea is central: some specialists or tasks suit voice; others suit text; the user's preferences also matter. Show how a recommendation follows from those inputs. For example: “Send the part number by text” or “You prefer written repair steps.”

Users should be able to change that choice. “Prefers SMS” is different from requesting a particular message. A successful tool result is different from a message being delivered. A phone number is a contact reference, not proof of identity.

The ambition to choose the channel with the highest success rate is a future optimization. Initial designs should use understandable capability and preference rules, without invented performance percentages.

## Screens to explore

| Screen or state | Required information | Main interaction |
| --- | --- | --- |
| Start and contact | Working product name, available support, fictional profile context, current case if present | Begin or resume support |
| Active conversation | Connection status, current speaker, readable captions, relevant equipment, specialist activity | Speak, interrupt, correct details, or end the call through the available client |
| Specialist result | Confirmed findings, one useful next step, evidence from the fictional catalog, any pending work | Confirm the step, ask a question, or request another specialist |
| Follow-up | A preview or summary of the requested message, chosen channel, destination label, delivery state | Request the recap or select a different eligible channel |
| Case recap | Diagnosis, attempted steps, unresolved items, messages, and continuation point | Resume the case |
| Preferences | Language, preferred channels, and useful equipment details | Change a preference or correct context |

Keep the current conversation and next useful action prominent. Place longer history, equipment details, and specialist explanations behind progressive disclosure. Show a short user-facing reason for an action, rather than internal model reasoning.

For the desktop call setup, distinguish a separate Twilio Dev Phone from an eventual embedded dialer. If mute, microphone permissions, or call controls live in the phone client, the companion UI should not pretend to control them. Annotate where controls belong in each concept.

## Interaction states

Design the transitions as carefully as the ideal screen:

| Situation | Required behavior |
| --- | --- |
| Connecting or reconnecting | Make the connection state clear and distinguish recovery from an active conversation |
| User speaking or agent speaking | Identify the speaker in text as well as visually; motion should have a purpose |
| User interrupts | The UI reflects that the agent is listening; background work retains its own status |
| Specialist working | Name the assignment and show a truthful status without fake progress percentages |
| Specialist delayed | Explain that the result is pending and keep the rest of the interface usable |
| Specialist fails | Give a useful retry or alternate path; do not show a successful diagnosis |
| Caller changes the symptom | Show the new problem and prevent the old result from becoming the current recommendation |
| Message queued or submitted | Show that it is on its way; reserve “Delivered” for confirmed delivery |
| Message delivery fails | Preserve the result in the case and offer another supported route |
| Call ends with work pending | Preserve the case; make any requested follow-up and pending work understandable |
| Several cases could match a reply | Ask the user which case to continue |

For connection failures, provide an understandable recovery action. For uncertain outcomes, use “Delivery not confirmed” or similarly precise language. Preserve a distinction between a proposed repair and the caller confirming that the problem is resolved.

## Three visual directions

Explore these as genuinely different layouts, not palette variations. They are starting points for the designer, not approved styles.

| Direction | Layout and character | What it should demonstrate |
| --- | --- | --- |
| Ship bridge console | A composed desktop workspace with a dominant conversation area, contextual equipment panel, and specialist activity rail. Warm amber, coral, and lavender accents on a dark neutral base; rounded console divisions inspired by Star Trek interfaces. | The audience can immediately follow the crew, specialists, and changing case state. |
| Personal communicator | A quiet, focused interface with one expressive listening element, large captions, and a compact contextual card. Specialist findings arrive as relevant cards. Strong mobile adaptation. | The user feels accompanied by a personal agent without having to operate a dashboard. |
| Communications desk | A shared case timeline where spoken exchanges, specialist findings, and text follow-ups have distinct but related treatments. A persistent contact and preference area explains channel changes. | Voice and text feel like one continuous support relationship. |

Use the same active-call scenario and sample data across all three so the team can compare hierarchy and interaction. Include one more state for each concept that reveals how it behaves: a specialist result, an interruption, or a text follow-up.

Explore typography, spacing, shape, iconography, and motion together. Aim for legible, characterful science fiction with restrained humor. Decorative controls should not look actionable. Familiar task labels should remain understandable even when the surrounding presentation is theatrical.

## Sample content

All records below are invented design fixtures, not real account data or existing application behavior. Use consistent data across the concepts.

| Field | Fixture |
| --- | --- |
| Crew member | Commander Avery Chen |
| Ship | USS Wayfinder |
| Equipment | Replicator RPL-2400, Deck 7 |
| Case | HF-042 |
| Symptom | Coffee arrives cold; other drinks have not yet been checked |
| Relevant history | Thermal calibration completed two weeks ago |
| Preferences | English; spoken troubleshooting; written repair steps by SMS |
| Engineering assignment | Check the thermal calibration procedure for this model |
| Engineering result | Calibration drift is a possible cause; ask whether other hot drinks are affected |
| Logistics assignment | Check availability of a compatible thermal regulator |
| Logistics result | One compatible regulator is available at the fictional station depot; no reservation has been made |

Useful example copy:

- Opening: “The Federation is always watching. Hailing frequencies open.”
- Context: “I have your RPL-2400 on Deck 7. What is it doing?”
- Handoff: “Engineering is checking the thermal calibration procedure.”
- Correction: “Understood. Tea is cold too. I have updated the case.”
- Follow-up offer: “Would you like the repair steps by text?”
- Pending delivery: “Repair summary queued.”
- Confirmed delivery: “Repair summary delivered.”
- Incomplete work: “Your call has ended. The parts check is still pending.”

The proposed spoken phrase can follow the pattern “Authorization, Chen, Avery, Alpha four eight four Beta seven.” It loads a seeded demo profile. Describe the state as “Demo profile loaded,” not “Voiceprint verified.”

## Accessibility and recording

The primary experience should work with captions and visible status even when muted. Support keyboard navigation, clear focus, readable contrast, and reduced motion. Use labels and icons as well as color to distinguish speakers, specialists, and errors.

Design an initial desktop composition at approximately 1440 by 900 and consider how it reads when the recording is reduced to a smaller video player. Favor short, readable text over dense telemetry. Show a mobile adaptation around 390 pixels wide for the most promising direction in a later pass.

Keep the active conversation stable as captions and results arrive. Users should be able to review earlier content without being forced back to the latest line. Show useful task summaries rather than a scrolling wall of technical events.

Motion may distinguish listening, speaking, and a newly arrived result. It should not imply an action completed or monopolize attention. The opening joke should remain clear as text when audio is unavailable.

## Technical boundaries that affect design

The proposed implementation is a Railway application using FastAPI and Twilio Agent Connect, GPT-Live for conversation, specialist tools behind Responses delegation, and Postgres for durable case state. A small web frontend presents the companion interface. These are implementation candidates; the designer should not expose framework, model, or provider terminology in ordinary user flows.

The existing local OpenAI playground has a voice interface and session handling. The full Twilio, specialist, and cross-channel experience is still proposed. Do not treat a polished mockup as evidence that an integration already works.

Keep these boundaries visible in annotations where relevant:

- Profile, case, specialist task, and delivery records are separate. They persist independently of a particular call screen.
- A specialist result can arrive after the user changes the problem or ends a call. It must remain associated with the correct case and task.
- The initial personal agent and specialists collaborate through backend tools. Separate autonomous agents placing phone calls to one another are outside the first version.
- Photos are a stretch feature. Use an explicit upload or capture action attached to the case; a vision-capable backend returns findings to the voice experience. Automatic video capture every 15 seconds is not an established requirement.
- Speaker biometrics are outside the initial scope. The spoken authorization phrase is part of the fictional demo.
- Klingon support, emergency scenarios, and requested outbound callbacks are stretch ideas that need their own design and rehearsal.
- Text delivery and callback permissions must correspond to what the user requested. A saved preference alone does not initiate contact.

Relevant technical references, if needed for interaction details: [OpenAI delegation and visual context](https://developers.openai.com/api/docs/guides/live-delegation), [Twilio GPT-Live integration](https://www.twilio.com/en-us/blog/developers/tutorials/integrations/tac-gpt-live-voice-ai-agent-python), and [Twilio Dev Phone](https://www.twilio.com/docs/labs/dev-phone).

## Requested design deliverables

For the first pass, produce:

1. Three distinct desktop concepts using the directions above or stronger alternatives. For each, show the same active-call moment and one additional interaction state.
2. A short rationale for each concept: what it emphasizes, how it supports a voice conversation, and its main tradeoff.
3. An annotated flow covering contact, profile loading, diagnosis, specialist result, requested text follow-up, and case recap. Clearly separate core screens from stretch features.
4. Proposed type, color, spacing, component, and motion choices sufficient to compare the concepts.
5. A recommendation based on clarity for the caller, readability on camera, personality, and implementation effort. Explain which ideas could be combined without losing coherence.

After Sterling and Michael choose a direction, develop responsive layouts, detailed component states, and an interactive prototype. Keep the first pass focused on design exploration; working calls, sends, deployments, and final production code are separate implementation work.

The design succeeds when a viewer can tell who the agent is helping, what is wrong, which specialist is working, what has actually happened, and what comes next. The caller should be able to keep talking naturally while the interface makes that story clear.
