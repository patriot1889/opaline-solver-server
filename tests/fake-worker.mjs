process.on('message', message => {
  if (message.mintDeadline) process.send({ ok: false, code: 'mint_deadline', status: 504 });
  else if (message.hang) for (;;) {}
  else if (message.crash) process.exit(1);
  else setTimeout(() => process.send({ ok: true, result: { role: process.argv[2], value: message.value, pid: process.pid, deadline: message.deadline, endpoint: process.env.GENERATE_IT_ENDPOINT } }), message.delay ?? 0);
});
