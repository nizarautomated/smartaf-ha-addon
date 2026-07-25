# SmartAF deploy agent 0.6.3

- Install `python3` and `py3-pip` in the Home Assistant Alpine base image before installing Python requirements.
- Fix the 0.6.2 build failure where `/bin/ash` reported `python3: not found`.
- Keep all app options and runtime behavior unchanged.
