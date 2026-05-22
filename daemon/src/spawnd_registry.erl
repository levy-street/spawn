-module(spawnd_registry).
-behaviour(gen_server).

-export([start_link/0, create/2, restart/2, register/2, unregister/1, unregister/2, lookup/1, ids/0, status/0]).
-export([init/1, handle_call/3, handle_cast/2, handle_info/2, code_change/3]).

start_link() ->
    gen_server:start_link({local, ?MODULE}, ?MODULE, [], []).

create(AgentId, Spec) ->
    gen_server:call(?MODULE, {create, AgentId, Spec}, infinity).

restart(AgentId, Spec) ->
    gen_server:call(?MODULE, {restart, AgentId, Spec}, infinity).

register(AgentId, Pid) ->
    gen_server:call(?MODULE, {register, AgentId, Pid}).

unregister(AgentId) ->
    gen_server:cast(?MODULE, {unregister, AgentId, undefined}).

unregister(AgentId, Pid) ->
    gen_server:cast(?MODULE, {unregister, AgentId, Pid}).

lookup(AgentId) ->
    gen_server:call(?MODULE, {lookup, AgentId}).

ids() ->
    gen_server:call(?MODULE, ids).

status() ->
    gen_server:call(?MODULE, status).

init([]) ->
    {ok, #{agents => #{}}}.

handle_call({create, AgentId, Spec0}, _From, State = #{agents := Agents}) ->
    case maps:get(AgentId, Agents, undefined) of
        undefined ->
            Spec = Spec0#{agent_id => AgentId},
            start_agent(AgentId, Spec, Agents, State);
        {Pid, _Ref} ->
            {reply, {ok, Pid}, State}
    end;
handle_call({restart, AgentId, Spec0}, _From, State = #{agents := Agents}) ->
    Spec = Spec0#{agent_id => AgentId},
    Agents1 = stop_existing(AgentId, Agents),
    start_agent(AgentId, Spec, Agents1, State);
handle_call({register, AgentId, Pid}, _From, State = #{agents := Agents}) ->
    Ref = monitor(process, Pid),
    {reply, ok, State#{agents := Agents#{AgentId => {Pid, Ref}}}};
handle_call({lookup, AgentId}, _From, State = #{agents := Agents}) ->
    Reply =
        case maps:get(AgentId, Agents, undefined) of
            undefined -> not_found;
            {Pid, _} -> {ok, Pid}
        end,
    {reply, Reply, State};
handle_call(ids, _From, State = #{agents := Agents}) ->
    {reply, maps:keys(Agents), State};
handle_call(status, _From, State = #{agents := Agents}) ->
    Rows = [
        agent_status(Id, Pid)
     || {Id, {Pid, _Ref}} <- maps:to_list(Agents)
    ],
    {reply, #{<<"agents">> => Rows}, State}.

handle_cast({unregister, AgentId, undefined}, State = #{agents := Agents}) ->
    Agents1 = demonitor_existing(AgentId, Agents),
    {noreply, State#{agents := Agents1}};
handle_cast({unregister, AgentId, Pid}, State = #{agents := Agents}) ->
    Agents1 =
        case maps:get(AgentId, Agents, undefined) of
            {Pid, Ref} ->
                erlang:demonitor(Ref, [flush]),
                maps:remove(AgentId, Agents);
            _ ->
                Agents
        end,
    {noreply, State#{agents := Agents1}}.

handle_info({'DOWN', Ref, process, Pid, _Reason}, State = #{agents := Agents}) ->
    {noreply, State#{agents := remove_by_ref(Pid, Ref, Agents)}};
handle_info(_Msg, State) ->
    {noreply, State}.

code_change(_OldVsn, State, _Extra) ->
    {ok, State}.

agent_status(Id, Pid) ->
    try spawnd_agent:status(Pid) of
        Status -> Status
    catch
        _:_ -> #{<<"agent_id">> => Id, <<"pid">> => null}
    end.

start_agent(AgentId, Spec, Agents, State) ->
    case spawnd_agent_sup:start_agent(Spec) of
        {ok, Pid} ->
            Ref = monitor(process, Pid),
            {reply, {ok, Pid}, State#{agents := Agents#{AgentId => {Pid, Ref}}}};
        Other ->
            {reply, Other, State#{agents := Agents}}
    end.

stop_existing(AgentId, Agents) ->
    case maps:get(AgentId, Agents, undefined) of
        undefined ->
            Agents;
        {Pid, Ref} ->
            erlang:demonitor(Ref, [flush]),
            spawnd_agent:stop_agent(Pid),
            wait_down(Pid, 7000),
            maps:remove(AgentId, Agents)
    end.

demonitor_existing(AgentId, Agents) ->
    case maps:get(AgentId, Agents, undefined) of
        {_Pid, Ref} -> erlang:demonitor(Ref, [flush]);
        undefined -> ok
    end,
    maps:remove(AgentId, Agents).

remove_by_ref(Pid, Ref, Agents) ->
    maps:filter(
        fun(_AgentId, {AgentPid, AgentRef}) ->
            not (AgentPid =:= Pid andalso AgentRef =:= Ref)
        end,
        Agents
    ).

wait_down(Pid, Timeout) ->
    Ref = monitor(process, Pid),
    receive
        {'DOWN', Ref, process, Pid, _Reason} ->
            ok
    after Timeout ->
        exit(Pid, kill),
        receive
            {'DOWN', Ref, process, Pid, _Reason} -> ok
        after 1000 ->
            timeout
        end
    end.

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

stale_unregister_does_not_remove_restarted_agent_test() ->
    AgentId = <<"00000000-0000-0000-0000-000000000001">>,
    OldPid = spawn(fun() -> receive stop -> ok end end),
    NewPid = spawn(fun() -> receive stop -> ok end end),
    OldRef = monitor(process, OldPid),
    NewRef = monitor(process, NewPid),
    State = #{agents => #{AgentId => {NewPid, NewRef}}},
    {noreply, #{agents := Agents}} = handle_cast({unregister, AgentId, OldPid}, State),
    ?assertEqual({NewPid, NewRef}, maps:get(AgentId, Agents)),
    erlang:demonitor(OldRef, [flush]),
    erlang:demonitor(NewRef, [flush]),
    OldPid ! stop,
    NewPid ! stop.

matching_unregister_removes_agent_and_monitor_test() ->
    AgentId = <<"00000000-0000-0000-0000-000000000002">>,
    Pid = spawn(fun() -> receive stop -> ok end end),
    Ref = monitor(process, Pid),
    State = #{agents => #{AgentId => {Pid, Ref}}},
    {noreply, #{agents := Agents}} = handle_cast({unregister, AgentId, Pid}, State),
    ?assertEqual(false, maps:is_key(AgentId, Agents)),
    Pid ! stop.

down_message_removes_matching_agent_test() ->
    AgentId = <<"00000000-0000-0000-0000-000000000003">>,
    Pid = spawn(fun() -> receive stop -> ok end end),
    Ref = monitor(process, Pid),
    State = #{agents => #{AgentId => {Pid, Ref}}},
    {noreply, #{agents := Agents}} = handle_info({'DOWN', Ref, process, Pid, normal}, State),
    ?assertEqual(false, maps:is_key(AgentId, Agents)),
    erlang:demonitor(Ref, [flush]),
    Pid ! stop.
-endif.
