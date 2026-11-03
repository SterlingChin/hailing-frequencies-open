# OpenAI preparation

Use the [root setup instructions](../../../README.md); there is no separate installation in this folder. Put your own `OPENAI_API_KEY` in the root `.env` before authorized API requests.

Select stack `openai`, environment `production`. The configured base is `https://api.openai.com/v1`, so use contract-relative paths such as `/responses`, not `/v1/responses`.

Read [GOTCHAS](GOTCHAS.md), [BUGS](BUGS.md), the [examples](examples/README.md), and the relevant operation in `.sannr/stacks/openai/sannr.json` from the root. The library contains 349 bound operations and 121 authored notes; seven additional entries remain unbound in `unsorted`.

The [Live reference archive](../../../.sannr/stacks/openai/docs/live/README.md) preserves user-supplied October 9 documentation. The references and imported preparation notes do not establish current model access, billing or end-to-end voice behavior for your account.
