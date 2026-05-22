-module(spawnd_registry).
-behaviour(gen_server).

-export([start_link/0, create/2, register/2, unregister/1, lookup/1, ids/0, status/0]).
-export([init/1, handle_call/3, handle_cast/2, code_change/3]).

start_link() ->
    gen_server:start_link({local, ?MODULE}, ?MODULE, [], []).

create(AgentId, Spec) ->
    gen_server:call(?MODULE, {create, AgentId, Spec}, infinity).

register(AgentId, Pid) ->
    gen_server:call(?MODULE, {register, AgentId, Pid}).

unregister(AgentId) ->
    gen_server:cast(?MODULE, {unregister, AgentId}).

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
            case spawnd_agent_sup:start_agent(Spec) of
                {ok, Pid} ->
                    Ref = monitor(process, Pid),
                    {reply, {ok, Pid}, State#{agents := Agents#{AgentId => {Pid, Ref}}}};
                Other ->
                    {reply, Other, State}
            end;
        {Pid, _Ref} ->
            {reply, {ok, Pid}, State}
    end;
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

handle_cast({unregister, AgentId}, State = #{agents := Agents}) ->
    {noreply, State#{agents := maps:remove(AgentId, Agents)}}.

code_change(_OldVsn, State, _Extra) ->
    {ok, State}.

agent_status(Id, Pid) ->
    try spawnd_agent:status(Pid) of
        Status -> Status
    catch
        _:_ -> #{<<"agent_id">> => Id, <<"pid">> => null}
    end.
