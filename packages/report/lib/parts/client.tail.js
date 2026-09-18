    exports.inject = ['slots', 'timer', 'redteamSettingsUI']
    exports.apply = function (ctx) { return applyClient(ctx) }
    return module.exports
  }
});
