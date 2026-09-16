    exports.inject = ['slots', 'timer']
    exports.apply = function (ctx) { return applyClient(ctx) }
    return module.exports
  }
});
