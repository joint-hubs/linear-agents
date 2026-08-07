
<dev_squad>

> Obszar DEVELOPMENTU jako zestaw agentów (lead + subagenci). Bierze context z taska linear, planuje, koduje, oddaje do `In Review`. Spec: [agent-2-dev](../agents/agent-2-dev.md). Launchery — na końcu.

</dev_squad>

<dev_squad_goal>
Z taska w Linear dowieźć branch z kodem + self-test + komentarz „jak testować",
task w `In Review` (`ai:coded`), z bezpiecznikami.
</dev_squad_goal>

<dev_squad_subagents>

| Sub-agent        | Odpowiedzialność                                                 |
| ---------------- | ---------------------------------------------------------------- |
| **lead** (`dev`) | pick up task, plan-mode, checkpoint, handoff                     |
| **recon**        | analiza task+kod → context packet (kluczowe pliki, wzorce, luki) |
| **implementer**  | dev agent in a session                                           |
| **refactorer**   | multi-file / MCP-heavy (najlepszy tool-calling)                  |
| **debugger**     | hard bug / decyzja architektoniczna                              |
</dev_squad_subagents>

<human_in_the_loop>
Niejasne → komentarz @Mateusz (PL) + `needs:answer` → **sleep**. Plan gotowy → `needs:approval` → **✅ = exit plan-mode**.
</human_in_the_loop>


<acceptance_criteria>
- [ ] Wybiera task
- [ ] Plan-mode pokazuje plan; po akceptacji wprowadza zmiany w kodzie.
- [ ] Checkpoint → STATE.md; self-test (delivery-loop) przed In Review.
- [ ] Task → In Review z `ai:coded` + komentarz „jak testować" (PL).
</acceptance_criteria>