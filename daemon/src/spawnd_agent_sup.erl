-module(spawnd_agent_sup).
-behaviour(supervisor).

-export([start_link/0, start_agent/1, init/1]).

start_link() ->
    supervisor:start_link({local, ?MODULE}, ?MODULE, []).

start_agent(Spec) ->
    supervisor:start_child(?MODULE, [Spec]).

init([]) ->
    Child = #{
        id => spawnd_agent,
        start => {spawnd_agent, start_link, []},
        restart => temporary,
        shutdown => 5000,
        type => worker,
        modules => [spawnd_agent]
    },
    {ok, {{simple_one_for_one, 10, 10}, [Child]}}.

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

agents_are_direct_subprocess_workers_test() ->
    {ok, {{simple_one_for_one, 10, 10}, [Child]}} = init([]),
    ?assertEqual(spawnd_agent, maps:get(id, Child)),
    ?assertEqual(temporary, maps:get(restart, Child)),
    ?assertEqual(worker, maps:get(type, Child)).
-endif.
