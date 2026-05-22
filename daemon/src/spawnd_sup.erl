-module(spawnd_sup).
-behaviour(supervisor).

-export([start_link/0, init/1]).

start_link() ->
    supervisor:start_link({local, ?MODULE}, ?MODULE, []).

init([]) ->
    AgentSup = #{
        id => spawnd_agent_sup,
        start => {spawnd_agent_sup, start_link, []},
        restart => permanent,
        shutdown => infinity,
        type => supervisor,
        modules => [spawnd_agent_sup]
    },
    Registry = #{
        id => spawnd_registry,
        start => {spawnd_registry, start_link, []},
        restart => permanent,
        shutdown => 5000,
        type => worker,
        modules => [spawnd_registry]
    },
    Control = #{
        id => spawnd_control,
        start => {spawnd_control, start_link, []},
        restart => permanent,
        shutdown => 5000,
        type => worker,
        modules => [spawnd_control]
    },
    Ws = #{
        id => spawnd_ws,
        start => {spawnd_ws, start_link, []},
        restart => permanent,
        shutdown => 5000,
        type => worker,
        modules => [spawnd_ws]
    },
    {ok, {{one_for_one, 5, 10}, [AgentSup, Registry, Control, Ws]}}.

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

supervises_core_services_permanently_test() ->
    {ok, {{one_for_one, 5, 10}, Children}} = init([]),
    Ids = [maps:get(id, Child) || Child <- Children],
    ?assertEqual([spawnd_agent_sup, spawnd_registry, spawnd_control, spawnd_ws], Ids),
    ?assert(lists:all(fun(Child) -> maps:get(restart, Child) =:= permanent end, Children)).
-endif.
