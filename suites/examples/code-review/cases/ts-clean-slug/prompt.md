Review this change to a TypeScript module. Report every bug the change introduces:
correctness and security problems, not style.

The code after the change, with the line numbers to cite:

{{fixture}}

The change that produced it:

{{diff}}

Answer with JSON only, in this shape, and nothing else:

{"findings": [{"file": "<path>", "line": <first line, in the changed file>, "end_line": <last line>, "severity": "critical|high|medium|low|info", "title": "<one line>", "explanation": "<why it is wrong>"}]}

An empty list means you found nothing wrong.
