# EdgeFuzz LLM demo recording
#
# Records the full pipeline: static mutations + LLM semantic mutations + triage.
# The OPENAI_API_KEY is read from your shell environment at record time —
# it is NEVER embedded in this file and is safe to commit.
#
# To record:
#   OPENAI_API_KEY=sk-... vhs media/demo-llm.tape
#
# Or with Anthropic:
#   ANTHROPIC_API_KEY=sk-ant-... vhs media/demo-llm.tape
#
# Output: media/demo-llm.gif

Output media/demo-llm.gif

Set Theme "Catppuccin Mocha"
Set FontSize 14
Set Width 1100
Set Height 650
Set Padding 20

# Type the command — vhs substitutes $OPENAI_API_KEY from your shell env at record time.
# The resulting GIF is a rendered image; the key value is never stored as text.
Type "OPENAI_API_KEY=$OPENAI_API_KEY npx edgefuzz --demo"
Sleep 500ms
Enter

# LLM mutation generation phase (~5-8s depending on API latency)
Sleep 10s

# Fuzzing phase (~5s)
Sleep 8s

# Triage phase (~5s)
Sleep 8s

# Hold on final summary
Sleep 4s
