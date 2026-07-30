<realtime_delegation>
  <source>transcript_tail_flush</source>
  <input>The user just ended their realtime session. Here is the remaining handoff/transcript tail. You probably do not have to do anything; acknowledge the handoff unless the transcript itself asks for something.</input>
{{#if transcriptDelta}}  <transcript_delta>{{escapeXml transcriptDelta}}</transcript_delta>
{{/if}}</realtime_delegation>
