# EdgeFuzz static demo recording (no LLM key needed)
#
# Records the static-only pipeline. Safe to run without any API key.
# Use demo-llm.tape to record the full LLM-augmented pipeline.
#
# To record:
#   vhs media/demo.tape
#
# Output: media/demo.gif

Output media/demo.gif

Set Theme "Catppuccin Mocha"
Set FontSize 14
Set Width 1000
Set Height 600
Set Padding 20

Type "npx edgefuzz --demo"
Sleep 500ms
Enter

# Demo runs ~5-8 seconds in static mode
Sleep 22s
