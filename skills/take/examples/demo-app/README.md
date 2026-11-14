# Boards: demo app

A tiny app to build and test Take against. One flow: **New project → type a name → Create → the new card appears.**

```sh
npm run demo        # → http://127.0.0.1:4300/
```

What's in it, on purpose:

- **Button**: *New project* (hover and press states).
- **Text field**: *Name* in a dialog; *Create* stays disabled until you type.
- **Wait**: *Create* pretends to save for 0.7 s with a spinner, so takes have something to wait for.
- **List**: the *Projects* grid; the new card slides in at the front with a fading highlight.
- **Transitions**: dialog fade and scale, backdrop fade, toast in and out after 2.5 s.

Deterministic: no dates, no randomness, no network, so every take looks the same. Targets have proper roles and labels (`button "New project"`, `dialog "New project"`, `textbox "Name"`, `list "Projects"`).
