-module(spawnd_app).
-behaviour(application).

-export([start/2, stop/1]).

start(_Type, _Args) ->
    spawnd_sup:start_link().

stop(_State) ->
    ok.
