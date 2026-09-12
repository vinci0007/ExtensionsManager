export default {
  capabilities: {
    'demo.hello': async () => ({ message: 'hello from node extension' }),
  },
  async activate(context) {
    context.logger?.info('node extension activated')
  },
}
